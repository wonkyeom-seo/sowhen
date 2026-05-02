import "dotenv/config";
import bcrypt from "bcryptjs";
import express from "express";
import session from "express-session";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Server } from "socket.io";
import {
  initStorage,
  kakaoFile,
  planFile,
  plansIndexFile,
  readJson,
  usersFile,
  withWriteLock,
  writeJson
} from "./storage.js";

const PORT = Number(process.env.PORT || 4545);
const SESSION_SECRET = process.env.SESSION_SECRET || "sowhen-local-session";
const isProduction = process.env.NODE_ENV === "production";

function now() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 14)}`;
}

function cleanText(value, max = 500) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanLongText(value, max = 2000) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
}

function isDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function daysBetween(startDate, endDate) {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  return Math.round((end - start) / 86400000);
}

function normalizeDates(dates, startDate, endDate) {
  if (!Array.isArray(dates)) {
    return [];
  }

  return [...new Set(dates.filter(isDateOnly).filter((date) => date >= startDate && date <= endDate))].sort();
}

function safeUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    username: user.username
  };
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "로그인이 필요합니다." });
  }

  next();
}

function sendPlan(io, plan) {
  io.to(`plan:${plan.id}`).emit("plan:update", plan);
}

async function loadPlan(planId) {
  try {
    return await readJson(planFile(planId), null);
  } catch (error) {
    if (error.message === "Invalid plan id") {
      return null;
    }

    throw error;
  }
}

async function savePlan(plan) {
  await writeJson(planFile(plan.id), plan);

  const index = await readJson(plansIndexFile, { plans: [] });
  const summary = {
    id: plan.id,
    title: plan.title,
    description: plan.description,
    deadline: plan.deadline,
    startDate: plan.startDate,
    endDate: plan.endDate,
    maxParticipants: plan.maxParticipants,
    creatorId: plan.creatorId,
    creatorName: plan.creatorName,
    participantCount: plan.responses.length,
    chatCount: plan.chat.length,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt
  };

  const existing = index.plans.findIndex((item) => item.id === plan.id);
  if (existing >= 0) {
    index.plans[existing] = summary;
  } else {
    index.plans.unshift(summary);
  }

  index.plans.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  await writeJson(plansIndexFile, index);
}

function validatePlanInput(body, currentPlan = null) {
  const title = cleanText(body.title, 80);
  const description = cleanLongText(body.description, 1200);
  const deadline = String(body.deadline || "").slice(0, 10);
  const startDate = String(body.startDate || "").slice(0, 10);
  const endDate = String(body.endDate || "").slice(0, 10);
  const maxParticipants = Math.max(1, Math.min(999, Number.parseInt(body.maxParticipants || 12, 10) || 12));

  if (!title) {
    return { error: "약속 이름을 입력해 주세요." };
  }

  if (![deadline, startDate, endDate].every(isDateOnly)) {
    return { error: "날짜 형식이 올바르지 않습니다." };
  }

  if (startDate > endDate) {
    return { error: "시작일은 종료일보다 늦을 수 없습니다." };
  }

  if (daysBetween(startDate, endDate) > 120) {
    return { error: "날짜 범위는 최대 120일까지 가능합니다." };
  }

  return {
    value: {
      title,
      description,
      deadline,
      startDate,
      endDate,
      maxParticipants,
      responses: currentPlan?.responses || [],
      chat: currentPlan?.chat || []
    }
  };
}

async function createApp() {
  await initStorage();

  const app = express();
  const server = createServer(app);
  const io = new Server(server, {
    maxHttpBufferSize: 1e6
  });

  const sessionMiddleware = session({
    name: "sowhen.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 1000 * 60 * 60 * 24 * 14
    }
  });

  app.use(express.json({ limit: "1mb" }));
  app.use(sessionMiddleware);
  io.engine.use(sessionMiddleware);

  io.on("connection", (socket) => {
    socket.on("plan:join", (planId) => {
      if (/^plan_[a-z0-9]+$/.test(String(planId))) {
        socket.join(`plan:${planId}`);
      }
    });
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, port: PORT });
  });

  app.get("/api/auth/me", (req, res) => {
    res.json({
      user: safeUser(req.session.user),
      kakao: req.session.kakao || null
    });
  });

  app.post("/api/auth/register", async (req, res) => {
    const username = cleanText(req.body.username, 32);
    const password = String(req.body.password || "");

    if (!/^[a-zA-Z0-9가-힣_.-]{2,32}$/.test(username)) {
      return res.status(400).json({ error: "아이디는 2~32자의 문자, 숫자, 한글, _, ., -만 가능합니다." });
    }

    if (password.length < 4 || password.length > 72) {
      return res.status(400).json({ error: "비밀번호는 4자 이상 입력해 주세요." });
    }

    const result = await withWriteLock(async () => {
      const data = await readJson(usersFile, { users: [] });
      const exists = data.users.some((user) => user.username.toLowerCase() === username.toLowerCase());

      if (exists) {
        return { error: "이미 사용 중인 아이디입니다." };
      }

      const user = {
        id: makeId("user"),
        username,
        passwordHash: await bcrypt.hash(password, 10),
        createdAt: now()
      };

      data.users.push(user);
      await writeJson(usersFile, data);
      return { user };
    });

    if (result.error) {
      return res.status(409).json({ error: result.error });
    }

    req.session.user = safeUser(result.user);
    res.status(201).json({ user: safeUser(result.user) });
  });

  app.post("/api/auth/login", async (req, res) => {
    const username = cleanText(req.body.username, 32);
    const password = String(req.body.password || "");
    const data = await readJson(usersFile, { users: [] });
    const user = data.users.find((item) => item.username.toLowerCase() === username.toLowerCase());

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: "아이디 또는 비밀번호가 맞지 않습니다." });
    }

    req.session.user = safeUser(user);
    res.json({ user: safeUser(user) });
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => {
      res.clearCookie("sowhen.sid");
      res.json({ ok: true });
    });
  });

  app.get("/api/plans", requireAuth, async (req, res) => {
    const index = await readJson(plansIndexFile, { plans: [] });
    res.json({
      plans: index.plans.filter((plan) => plan.creatorId === req.session.user.id)
    });
  });

  app.post("/api/plans", requireAuth, async (req, res) => {
    const parsed = validatePlanInput(req.body);

    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }

    const createdAt = now();
    const plan = {
      id: makeId("plan"),
      ...parsed.value,
      creatorId: req.session.user.id,
      creatorName: req.session.user.username,
      createdAt,
      updatedAt: createdAt
    };

    await withWriteLock(async () => {
      await savePlan(plan);
    });

    res.status(201).json({ plan });
  });

  app.get("/api/plans/:id", async (req, res) => {
    const plan = await loadPlan(req.params.id);

    if (!plan) {
      return res.status(404).json({ error: "약속을 찾을 수 없습니다." });
    }

    res.json({
      plan,
      canEdit: Boolean(req.session.user && req.session.user.id === plan.creatorId)
    });
  });

  app.patch("/api/plans/:id", requireAuth, async (req, res) => {
    const result = await withWriteLock(async () => {
      const plan = await loadPlan(req.params.id);

      if (!plan) {
        return { status: 404, error: "약속을 찾을 수 없습니다." };
      }

      if (plan.creatorId !== req.session.user.id) {
        return { status: 403, error: "수정 권한이 없습니다." };
      }

      const parsed = validatePlanInput(req.body, plan);

      if (parsed.error) {
        return { status: 400, error: parsed.error };
      }

      const updatedPlan = {
        ...plan,
        ...parsed.value,
        updatedAt: now()
      };

      updatedPlan.responses = updatedPlan.responses.map((response) => ({
        ...response,
        dates: normalizeDates(response.dates, updatedPlan.startDate, updatedPlan.endDate)
      }));

      await savePlan(updatedPlan);
      return { plan: updatedPlan };
    });

    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }

    sendPlan(io, result.plan);
    res.json({ plan: result.plan });
  });

  app.post("/api/plans/:id/responses", async (req, res) => {
    const result = await withWriteLock(async () => {
      const plan = await loadPlan(req.params.id);

      if (!plan) {
        return { status: 404, error: "약속을 찾을 수 없습니다." };
      }

      const participantName = cleanText(req.body.participantName, 40);
      const mode = req.body.mode === "unavailable" ? "unavailable" : "available";
      const dates = normalizeDates(req.body.dates, plan.startDate, plan.endDate);

      if (!participantName) {
        return { status: 400, error: "이름을 입력해 주세요." };
      }

      const existingIndex = plan.responses.findIndex(
        (response) => response.participantName.toLowerCase() === participantName.toLowerCase()
      );

      if (existingIndex < 0 && plan.responses.length >= plan.maxParticipants) {
        return { status: 400, error: "참가 인원이 가득 찼습니다." };
      }

      const response = {
        id: existingIndex >= 0 ? plan.responses[existingIndex].id : makeId("resp"),
        participantName,
        mode,
        dates,
        updatedAt: now()
      };

      if (existingIndex >= 0) {
        plan.responses[existingIndex] = response;
      } else {
        plan.responses.push(response);
      }

      plan.responses.sort((a, b) => a.participantName.localeCompare(b.participantName, "ko"));
      plan.updatedAt = now();
      await savePlan(plan);
      return { plan };
    });

    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }

    sendPlan(io, result.plan);
    res.json({ plan: result.plan });
  });

  app.post("/api/plans/:id/chat/messages", async (req, res) => {
    const result = await withWriteLock(async () => {
      const plan = await loadPlan(req.params.id);

      if (!plan) {
        return { status: 404, error: "약속을 찾을 수 없습니다." };
      }

      const authorName = cleanText(req.body.authorName || req.session.user?.username, 40);
      const text = cleanLongText(req.body.text, 600);

      if (!authorName) {
        return { status: 400, error: "이름을 먼저 선택해 주세요." };
      }

      if (!text) {
        return { status: 400, error: "메시지를 입력해 주세요." };
      }

      const message = {
        id: makeId("msg"),
        authorName,
        authorUserId: req.session.user?.id || null,
        text,
        createdAt: now()
      };

      plan.chat.push(message);
      plan.chat = plan.chat.slice(-300);
      plan.updatedAt = now();
      await savePlan(plan);
      return { plan, message };
    });

    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }

    sendPlan(io, result.plan);
    res.status(201).json({ plan: result.plan, message: result.message });
  });

  app.delete("/api/plans/:id/chat/messages/:messageId", async (req, res) => {
    const result = await withWriteLock(async () => {
      const plan = await loadPlan(req.params.id);

      if (!plan) {
        return { status: 404, error: "약속을 찾을 수 없습니다." };
      }

      const message = plan.chat.find((item) => item.id === req.params.messageId);
      const requesterName = cleanText(req.body.authorName, 40);
      const isCreator = Boolean(req.session.user && req.session.user.id === plan.creatorId);
      const isAuthorByName =
        message && requesterName && message.authorName.toLowerCase() === requesterName.toLowerCase();
      const isAuthorByUser = Boolean(message?.authorUserId && req.session.user?.id === message.authorUserId);

      if (!message) {
        return { status: 404, error: "메시지를 찾을 수 없습니다." };
      }

      if (!isCreator && !isAuthorByName && !isAuthorByUser) {
        return { status: 403, error: "삭제 권한이 없습니다." };
      }

      plan.chat = plan.chat.filter((item) => item.id !== req.params.messageId);
      plan.updatedAt = now();
      await savePlan(plan);
      return { plan };
    });

    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }

    sendPlan(io, result.plan);
    res.json({ plan: result.plan });
  });

  app.get("/api/auth/kakao", (req, res) => {
    const clientId = process.env.KAKAO_REST_API_KEY;
    const redirectUri = process.env.KAKAO_REDIRECT_URI || `http://localhost:${PORT}/api/auth/kakao/callback`;

    if (!clientId) {
      return res.status(503).send("KAKAO_REST_API_KEY가 .env에 없습니다.");
    }

    const state = crypto.randomBytes(18).toString("hex");
    req.session.kakaoState = {
      value: state,
      planId: /^plan_[a-z0-9]+$/.test(String(req.query.planId || "")) ? String(req.query.planId) : null
    };

    const authorizeUrl = new URL("https://kauth.kakao.com/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("scope", "profile_nickname,talk_message");

    res.redirect(authorizeUrl.toString());
  });

  app.get("/api/auth/kakao/callback", async (req, res) => {
    const state = String(req.query.state || "");
    const code = String(req.query.code || "");
    const storedState = req.session.kakaoState;

    if (!code || !storedState || storedState.value !== state) {
      return res.status(400).send("카카오 로그인 상태가 만료되었습니다.");
    }

    const clientId = process.env.KAKAO_REST_API_KEY;
    const clientSecret = process.env.KAKAO_CLIENT_SECRET;
    const redirectUri = process.env.KAKAO_REDIRECT_URI || `http://localhost:${PORT}/api/auth/kakao/callback`;

    if (!clientId) {
      return res.status(503).send("KAKAO_REST_API_KEY가 .env에 없습니다.");
    }

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code
    });

    if (clientSecret) {
      tokenBody.set("client_secret", clientSecret);
    }

    const tokenResponse = await fetch("https://kauth.kakao.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8"
      },
      body: tokenBody
    });

    if (!tokenResponse.ok) {
      return res.status(502).send("카카오 토큰을 받을 수 없습니다.");
    }

    const token = await tokenResponse.json();
    const profileResponse = await fetch("https://kapi.kakao.com/v2/user/me", {
      headers: {
        Authorization: `Bearer ${token.access_token}`
      }
    });

    if (!profileResponse.ok) {
      return res.status(502).send("카카오 사용자 정보를 받을 수 없습니다.");
    }

    const profile = await profileResponse.json();
    const kakaoId = String(profile.id);
    const nickname = profile.properties?.nickname || profile.kakao_account?.profile?.nickname || "카카오 사용자";
    const account = {
      kakaoId,
      nickname,
      userId: req.session.user?.id || null,
      accessToken: token.access_token,
      refreshToken: token.refresh_token || null,
      expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null,
      scope: token.scope || "",
      connectedAt: now(),
      updatedAt: now()
    };

    await withWriteLock(async () => {
      const data = await readJson(kakaoFile, { accounts: [], notifications: [] });
      const existingIndex = data.accounts.findIndex((item) => item.kakaoId === kakaoId);

      if (existingIndex >= 0) {
        data.accounts[existingIndex] = {
          ...data.accounts[existingIndex],
          ...account
        };
      } else {
        data.accounts.push(account);
      }

      await writeJson(kakaoFile, data);
    });

    req.session.kakao = {
      kakaoId,
      nickname
    };

    const redirectPlanId = storedState.planId;
    delete req.session.kakaoState;
    res.redirect(redirectPlanId ? `/p/${redirectPlanId}?kakao=connected` : "/?kakao=connected");
  });

  app.post("/api/plans/:id/notifications", async (req, res) => {
    if (!req.session.kakao?.kakaoId) {
      return res.status(401).json({ error: "카카오 연결이 필요합니다." });
    }

    const plan = await loadPlan(req.params.id);

    if (!plan) {
      return res.status(404).json({ error: "약속을 찾을 수 없습니다." });
    }

    const allowedEvents = new Set(["deadline", "all_available", "day_before"]);
    const events = Array.isArray(req.body.events)
      ? req.body.events.filter((event) => allowedEvents.has(event))
      : ["deadline"];
    const participantName = cleanText(req.body.participantName, 40);

    await withWriteLock(async () => {
      const data = await readJson(kakaoFile, { accounts: [], notifications: [] });
      const nextNotification = {
        id: makeId("noti"),
        planId: plan.id,
        kakaoId: req.session.kakao.kakaoId,
        userId: req.session.user?.id || null,
        participantName,
        events: events.length ? events : ["deadline"],
        createdAt: now(),
        updatedAt: now()
      };

      data.notifications = data.notifications.filter(
        (item) => !(item.planId === plan.id && item.kakaoId === req.session.kakao.kakaoId)
      );
      data.notifications.push(nextNotification);
      await writeJson(kakaoFile, data);
    });

    res.json({ ok: true });
  });

  if (isProduction) {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", async (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  } else {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "custom"
    });

    app.use(vite.middlewares);
    app.use("*", async (req, res, next) => {
      try {
        const template = await fs.readFile(path.join(process.cwd(), "index.html"), "utf8");
        const html = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).set({ "Content-Type": "text/html" }).end(html);
      } catch (error) {
        vite.ssrFixStacktrace(error);
        next(error);
      }
    });
  }

  return { server };
}

createApp()
  .then(({ server }) => {
    server.listen(PORT, () => {
      console.log(`sowhen listening on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
