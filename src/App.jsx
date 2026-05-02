import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import {
  Bell,
  CalendarDays,
  Check,
  ChevronLeft,
  Copy,
  Home,
  Link2,
  LogOut,
  MessageCircle,
  PencilLine,
  Plus,
  Send,
  Trash2,
  UserRound,
  Users,
  X
} from "lucide-react";
import { api } from "./api.js";

const today = new Date().toISOString().slice(0, 10);
const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
const eventOptions = [
  { id: "deadline", label: "마감 후" },
  { id: "all_available", label: "모두 가능" },
  { id: "day_before", label: "하루 전" }
];

function addDays(dateString, amount) {
  const date = new Date(`${dateString}T00:00:00`);
  date.setDate(date.getDate() + amount);
  return toDateInput(date);
}

function toDateInput(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function displayDate(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  return `${date.getMonth() + 1}.${date.getDate()} ${weekdays[date.getDay()]}`;
}

function displayFullDate(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  return `${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일 ${weekdays[date.getDay()]}요일`;
}

function dateRange(startDate, endDate) {
  const dates = [];
  let cursor = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);

  while (cursor <= end) {
    dates.push(toDateInput(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}

function groupByMonth(items) {
  return items.reduce((groups, item) => {
    const date = new Date(`${item.date}T00:00:00`);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const label = `${date.getFullYear()}년 ${date.getMonth() + 1}월`;
    const current = groups.get(key) || { key, label, items: [] };
    current.items.push(item);
    groups.set(key, current);
    return groups;
  }, new Map());
}

function buildAvailability(plan) {
  const responses = plan.responses || [];
  return dateRange(plan.startDate, plan.endDate).map((date) => {
    const availableNames = responses
      .filter((response) =>
        response.mode === "available" ? response.dates.includes(date) : !response.dates.includes(date)
      )
      .map((response) => response.participantName);

    return {
      date,
      count: availableNames.length,
      total: responses.length,
      allAvailable: responses.length > 0 && availableNames.length === responses.length,
      availableNames
    };
  });
}

function useRoute() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = (nextPath) => {
    window.history.pushState({}, "", nextPath);
    setPath(nextPath);
    window.scrollTo({ top: 0 });
  };

  return { path, navigate };
}

export default function App() {
  const { path, navigate } = useRoute();
  const [session, setSession] = useState({ user: null, kakao: null });
  const [booting, setBooting] = useState(true);
  const [toast, setToast] = useState("");
  const planMatch = path.match(/^\/p\/([^/]+)/);

  const refreshSession = async () => {
    const data = await api("/api/auth/me");
    setSession(data);
    return data;
  };

  useEffect(() => {
    refreshSession().finally(() => setBooting(false));
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  if (booting) {
    return (
      <div className="app">
        <div className="boot">쏘왠</div>
      </div>
    );
  }

  return (
    <div className="app">
      <AppBar
        inPlan={Boolean(planMatch)}
        user={session.user}
        onBack={() => navigate("/")}
        onLogout={async () => {
          await api("/api/auth/logout", { method: "POST" });
          setSession({ user: null, kakao: null });
          navigate("/");
        }}
      />
      {planMatch ? (
        <PlanPage
          planId={planMatch[1]}
          session={session}
          refreshSession={refreshSession}
          navigate={navigate}
          notify={setToast}
        />
      ) : (
        <HomePage session={session} setSession={setSession} navigate={navigate} notify={setToast} />
      )}
      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}

function AppBar({ inPlan, user, onBack, onLogout }) {
  return (
    <header className="appbar">
      <div className="appbar-left">
        {inPlan ? (
          <button className="icon-button" onClick={onBack} aria-label="홈으로">
            <ChevronLeft size={21} />
          </button>
        ) : (
          <div className="brand-mark">쏘</div>
        )}
        <div>
          <div className="brand-title">쏘왠</div>
          <div className="brand-subtitle">그래서 언제 만날건데</div>
        </div>
      </div>
      {user ? (
        <button className="user-pill" onClick={onLogout}>
          <UserRound size={16} />
          <span>{user.username}</span>
          <LogOut size={15} />
        </button>
      ) : null}
    </header>
  );
}

function HomePage({ session, setSession, navigate, notify }) {
  if (!session.user) {
    return <AuthView setSession={setSession} notify={notify} />;
  }

  return <Dashboard user={session.user} navigate={navigate} notify={notify} />;
}

function AuthView({ setSession, notify }) {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);

    try {
      const data = await api(mode === "login" ? "/api/auth/login" : "/api/auth/register", {
        method: "POST",
        body: { username, password }
      });
      setSession({ user: data.user, kakao: null });
      notify(mode === "login" ? "로그인됐습니다." : "계정을 만들었습니다.");
    } catch (error) {
      notify(error.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="screen">
      <section className="hero-band">
        <div>
          <p className="eyebrow">sowhen</p>
          <h1>약속 날짜를 바로 맞춰요.</h1>
        </div>
        <CalendarDays size={34} />
      </section>

      <form className="auth-panel" onSubmit={submit}>
        <div className="segment">
          <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>
            로그인
          </button>
          <button type="button" className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>
            회원가입
          </button>
        </div>
        <label>
          아이디
          <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
        </label>
        <label>
          비밀번호
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
        </label>
        <button className="primary-button" disabled={saving}>
          {saving ? "처리 중" : mode === "login" ? "들어가기" : "시작하기"}
        </button>
      </form>
    </main>
  );
}

function Dashboard({ user, navigate, notify }) {
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  const loadPlans = async () => {
    setLoading(true);
    try {
      const data = await api("/api/plans");
      setPlans(data.plans);
    } catch (error) {
      notify(error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPlans();
  }, []);

  return (
    <main className="screen with-bottom-action">
      <section className="home-summary">
        <div>
          <p className="eyebrow">{user.username}</p>
          <h1>내 약속</h1>
        </div>
        <button className="round-action" onClick={() => setShowForm(true)} aria-label="약속 만들기">
          <Plus size={24} />
        </button>
      </section>

      <section className="list-section">
        {loading ? <div className="empty-state">불러오는 중</div> : null}
        {!loading && plans.length === 0 ? <div className="empty-state">아직 만든 약속이 없습니다.</div> : null}
        {plans.map((plan) => (
          <button key={plan.id} className="plan-card" onClick={() => navigate(`/p/${plan.id}`)}>
            <div className="plan-card-main">
              <strong>{plan.title}</strong>
              <span>{plan.description || "내용 없음"}</span>
            </div>
            <div className="plan-card-meta">
              <span>
                <Users size={14} /> {plan.participantCount}/{plan.maxParticipants}
              </span>
              <span>{displayDate(plan.deadline)} 마감</span>
            </div>
          </button>
        ))}
      </section>

      <nav className="bottom-nav">
        <button className="active">
          <Home size={19} />
          홈
        </button>
        <button onClick={() => setShowForm(true)}>
          <Plus size={19} />
          만들기
        </button>
      </nav>

      {showForm ? (
        <BottomSheet title="약속 만들기" onClose={() => setShowForm(false)}>
          <PlanForm
            onSubmit={async (payload) => {
              const data = await api("/api/plans", { method: "POST", body: payload });
              notify("약속을 만들었습니다.");
              navigate(`/p/${data.plan.id}`);
            }}
            submitLabel="공유 링크 만들기"
            notify={notify}
          />
        </BottomSheet>
      ) : null}
    </main>
  );
}

function PlanPage({ planId, session, refreshSession, navigate, notify }) {
  const [plan, setPlan] = useState(null);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("schedule");
  const [showEdit, setShowEdit] = useState(false);
  const [showName, setShowName] = useState(false);
  const [participantName, setParticipantName] = useState(
    () => window.localStorage.getItem(`sowhen:name:${planId}`) || ""
  );

  const loadPlan = async () => {
    setLoading(true);
    try {
      const data = await api(`/api/plans/${planId}`);
      setPlan(data.plan);
      setCanEdit(data.canEdit);
    } catch (error) {
      notify(error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPlan();
  }, [planId]);

  useEffect(() => {
    const socket = io();
    socket.emit("plan:join", planId);
    socket.on("plan:update", (nextPlan) => {
      setPlan(nextPlan);
    });
    return () => socket.disconnect();
  }, [planId]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("kakao") === "connected") {
      refreshSession();
      notify("카카오가 연결됐습니다.");
      window.history.replaceState({}, "", `/p/${planId}`);
    }
  }, [planId]);

  const chooseName = (name) => {
    const cleanName = name.trim();
    if (!cleanName) return;
    setParticipantName(cleanName);
    window.localStorage.setItem(`sowhen:name:${planId}`, cleanName);
    setShowName(false);
  };

  if (loading) {
    return <main className="screen"><div className="empty-state">약속을 불러오는 중</div></main>;
  }

  if (!plan) {
    return (
      <main className="screen">
        <div className="empty-state">약속을 찾을 수 없습니다.</div>
      </main>
    );
  }

  return (
    <main className="screen with-bottom-action">
      <section className="plan-hero">
        <div className="plan-hero-title">
          <p className="eyebrow">{displayFullDate(plan.deadline)} 마감</p>
          <h1>{plan.title}</h1>
          {plan.description ? <p>{plan.description}</p> : null}
        </div>
        <div className="hero-actions">
          <button
            className="icon-button filled"
            onClick={async () => {
              await copyText(`${window.location.origin}/p/${plan.id}`);
              notify("공유 링크를 복사했습니다.");
            }}
            aria-label="공유 링크 복사"
          >
            <Copy size={19} />
          </button>
          {canEdit ? (
            <button className="icon-button filled" onClick={() => setShowEdit(true)} aria-label="약속 수정">
              <PencilLine size={19} />
            </button>
          ) : null}
        </div>
      </section>

      <section className="identity-row">
        <button className="name-button" onClick={() => setShowName(true)}>
          <UserRound size={17} />
          <span>{participantName || "이름 선택"}</span>
        </button>
        <a className="kakao-button" href={`/api/auth/kakao?planId=${plan.id}`}>
          <Bell size={17} />
          카카오 연결
        </a>
      </section>

      <section className="participant-strip">
        {(plan.responses || []).map((response) => (
          <button key={response.id} onClick={() => chooseName(response.participantName)}>
            {response.participantName}
          </button>
        ))}
      </section>

      <div className="tabbar">
        <button className={tab === "schedule" ? "active" : ""} onClick={() => setTab("schedule")}>
          <CalendarDays size={17} />
          일정
        </button>
        <button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>
          <MessageCircle size={17} />
          채팅
        </button>
      </div>

      {tab === "schedule" ? (
        <SchedulePanel plan={plan} participantName={participantName} onNeedName={() => setShowName(true)} notify={notify} />
      ) : (
        <ChatPanel
          plan={plan}
          participantName={participantName}
          user={session.user}
          onNeedName={() => setShowName(true)}
          notify={notify}
        />
      )}

      <NotificationPanel plan={plan} kakao={session.kakao} participantName={participantName} notify={notify} />

      <nav className="bottom-nav">
        <button className={tab === "schedule" ? "active" : ""} onClick={() => setTab("schedule")}>
          <CalendarDays size={19} />
          일정
        </button>
        <button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>
          <MessageCircle size={19} />
          채팅
        </button>
        <button onClick={() => navigate("/")}>
          <Home size={19} />
          홈
        </button>
      </nav>

      {showName ? (
        <NameSheet
          initialName={participantName}
          responses={plan.responses || []}
          onChoose={chooseName}
          onClose={() => setShowName(false)}
        />
      ) : null}

      {showEdit ? (
        <BottomSheet title="약속 수정" onClose={() => setShowEdit(false)}>
          <PlanForm
            plan={plan}
            submitLabel="수정 완료"
            notify={notify}
            onSubmit={async (payload) => {
              const data = await api(`/api/plans/${plan.id}`, { method: "PATCH", body: payload });
              setPlan(data.plan);
              setShowEdit(false);
              notify("약속을 수정했습니다.");
            }}
          />
        </BottomSheet>
      ) : null}
    </main>
  );
}

function SchedulePanel({ plan, participantName, onNeedName, notify }) {
  const [mode, setMode] = useState("available");
  const [selectedDates, setSelectedDates] = useState(new Set());
  const [onlyAll, setOnlyAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const availability = useMemo(() => buildAvailability(plan), [plan]);
  const bestDates = useMemo(
    () =>
      [...availability]
        .filter((item) => item.count > 0)
        .sort((a, b) => b.count - a.count || a.date.localeCompare(b.date))
        .slice(0, 3),
    [availability]
  );

  useEffect(() => {
    const response = (plan.responses || []).find(
      (item) => item.participantName.toLowerCase() === participantName.toLowerCase()
    );

    if (response) {
      setMode(response.mode);
      setSelectedDates(new Set(response.dates));
    } else {
      setMode("available");
      setSelectedDates(new Set());
    }
  }, [participantName, plan]);

  const toggleDate = (date) => {
    setSelectedDates((current) => {
      const next = new Set(current);
      if (next.has(date)) {
        next.delete(date);
      } else {
        next.add(date);
      }
      return next;
    });
  };

  const save = async () => {
    if (!participantName) {
      onNeedName();
      return;
    }

    setSaving(true);
    try {
      await api(`/api/plans/${plan.id}/responses`, {
        method: "POST",
        body: {
          participantName,
          mode,
          dates: [...selectedDates].sort()
        }
      });
      notify("일정을 저장했습니다.");
    } catch (error) {
      notify(error.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="schedule-panel">
      <div className="summary-grid">
        <Stat label="참가" value={`${plan.responses.length}/${plan.maxParticipants}`} />
        <Stat label="기간" value={`${displayDate(plan.startDate)} - ${displayDate(plan.endDate)}`} />
      </div>

      {bestDates.length ? (
        <div className="best-row">
          {bestDates.map((item) => (
            <div className="best-chip" key={item.date}>
              <strong>{displayDate(item.date)}</strong>
              <span>{item.count}명 가능</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="section-head">
        <h2>전체 달력</h2>
        <label className="switch-line">
          <input type="checkbox" checked={onlyAll} onChange={(event) => setOnlyAll(event.target.checked)} />
          모두 가능한 날
        </label>
      </div>

      <CalendarGrid
        availability={availability}
        selectedDates={selectedDates}
        onlyAll={onlyAll}
        onToggleDate={toggleDate}
      />

      <div className="selection-dock">
        <div className="segment">
          <button className={mode === "available" ? "active" : ""} onClick={() => setMode("available")}>
            가능한 날
          </button>
          <button className={mode === "unavailable" ? "active" : ""} onClick={() => setMode("unavailable")}>
            안 되는 날
          </button>
        </div>
        <button className="primary-button" onClick={save} disabled={saving}>
          <Check size={18} />
          {saving ? "저장 중" : `${selectedDates.size}일 저장`}
        </button>
      </div>
    </section>
  );
}

function CalendarGrid({ availability, selectedDates, onlyAll, onToggleDate }) {
  const monthGroups = [...groupByMonth(availability).values()];

  return (
    <div className="calendar-stack">
      {monthGroups.map((month) => {
        const firstDate = new Date(`${month.items[0].date}T00:00:00`);
        const offset = firstDate.getDay();

        return (
          <div className="month-block" key={month.key}>
            <h3>{month.label}</h3>
            <div className="weekday-grid">
              {weekdays.map((day) => (
                <span key={day}>{day}</span>
              ))}
            </div>
            <div className="calendar-grid">
              {Array.from({ length: offset }).map((_, index) => (
                <span className="date-spacer" key={`spacer-${index}`} />
              ))}
              {month.items.map((item) => {
                const heat = item.total ? Math.max(0.12, item.count / item.total) : 0;
                const selected = selectedDates.has(item.date);
                const hidden = onlyAll && !item.allAvailable;
                const date = new Date(`${item.date}T00:00:00`);

                return (
                  <button
                    key={item.date}
                    className={`date-tile ${selected ? "selected" : ""} ${item.allAvailable ? "all" : ""}`}
                    style={{ "--heat": heat }}
                    disabled={hidden}
                    onClick={() => onToggleDate(item.date)}
                    title={`${displayFullDate(item.date)} ${item.count}명 가능`}
                  >
                    <span className="day-number">{date.getDate()}</span>
                    <span className="day-count">{item.count || "-"}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ChatPanel({ plan, participantName, user, onNeedName, notify }) {
  const [text, setText] = useState("");
  const listRef = useRef(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [plan.chat.length]);

  const send = async (event) => {
    event.preventDefault();

    if (!participantName && !user) {
      onNeedName();
      return;
    }

    try {
      await api(`/api/plans/${plan.id}/chat/messages`, {
        method: "POST",
        body: {
          authorName: participantName || user.username,
          text
        }
      });
      setText("");
    } catch (error) {
      notify(error.message);
    }
  };

  const remove = async (message) => {
    try {
      await api(`/api/plans/${plan.id}/chat/messages/${message.id}`, {
        method: "DELETE",
        body: {
          authorName: participantName || user?.username || ""
        }
      });
    } catch (error) {
      notify(error.message);
    }
  };

  return (
    <section className="chat-panel">
      <div className="message-list" ref={listRef}>
        {(plan.chat || []).length === 0 ? <div className="empty-state compact">메시지가 없습니다.</div> : null}
        {(plan.chat || []).map((message) => {
          const mine =
            message.authorName.toLowerCase() === (participantName || "").toLowerCase() ||
            (message.authorUserId && user?.id === message.authorUserId);
          const canDelete = mine || user?.id === plan.creatorId;

          return (
            <div className={`message ${mine ? "mine" : ""}`} key={message.id}>
              <div className="message-bubble">
                <div className="message-meta">
                  <strong>{message.authorName}</strong>
                  <span>{new Date(message.createdAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</span>
                </div>
                <p>{message.text}</p>
              </div>
              {canDelete ? (
                <button className="delete-message" onClick={() => remove(message)} aria-label="메시지 삭제">
                  <Trash2 size={15} />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      <form className="chat-compose" onSubmit={send}>
        <input value={text} onChange={(event) => setText(event.target.value)} placeholder="메시지" />
        <button className="send-button" aria-label="보내기">
          <Send size={18} />
        </button>
      </form>
    </section>
  );
}

function NotificationPanel({ plan, kakao, participantName, notify }) {
  const [events, setEvents] = useState(["deadline"]);
  const [saving, setSaving] = useState(false);

  const toggle = (eventId) => {
    setEvents((current) =>
      current.includes(eventId) ? current.filter((item) => item !== eventId) : [...current, eventId]
    );
  };

  const save = async () => {
    setSaving(true);
    try {
      await api(`/api/plans/${plan.id}/notifications`, {
        method: "POST",
        body: { events, participantName }
      });
      notify("알림을 저장했습니다.");
    } catch (error) {
      notify(error.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="notification-panel">
      <div className="section-head">
        <h2>카카오 알림</h2>
        {kakao ? <span className="connected-badge">{kakao.nickname}</span> : <Link2 size={17} />}
      </div>
      <div className="event-row">
        {eventOptions.map((event) => (
          <button key={event.id} className={events.includes(event.id) ? "active" : ""} onClick={() => toggle(event.id)}>
            {event.label}
          </button>
        ))}
      </div>
      <button className="secondary-button" onClick={save} disabled={saving || !kakao}>
        {kakao ? (saving ? "저장 중" : "알림 저장") : "카카오 연결 필요"}
      </button>
    </section>
  );
}

function NameSheet({ initialName, responses, onChoose, onClose }) {
  const [name, setName] = useState(initialName || "");

  return (
    <BottomSheet title="참가자 이름" onClose={onClose}>
      <div className="name-sheet">
        <div className="participant-grid">
          {responses.map((response) => (
            <button key={response.id} onClick={() => onChoose(response.participantName)}>
              {response.participantName}
            </button>
          ))}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onChoose(name);
          }}
        >
          <label>
            이름
            <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </label>
          <button className="primary-button">선택</button>
        </form>
      </div>
    </BottomSheet>
  );
}

function PlanForm({ plan, onSubmit, submitLabel, notify }) {
  const [form, setForm] = useState(() => ({
    title: plan?.title || "",
    description: plan?.description || "",
    deadline: plan?.deadline || addDays(today, 7),
    startDate: plan?.startDate || today,
    endDate: plan?.endDate || addDays(today, 14),
    maxParticipants: plan?.maxParticipants || 12
  }));
  const [saving, setSaving] = useState(false);

  const update = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      await onSubmit(form);
    } catch (error) {
      notify(error.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="plan-form" onSubmit={submit}>
      <label>
        약속 이름
        <input value={form.title} onChange={(event) => update("title", event.target.value)} />
      </label>
      <label>
        내용
        <textarea value={form.description} onChange={(event) => update("description", event.target.value)} rows={3} />
      </label>
      <div className="form-grid">
        <label>
          마감
          <input type="date" value={form.deadline} onChange={(event) => update("deadline", event.target.value)} />
        </label>
        <label>
          인원
          <input
            type="number"
            min="1"
            max="999"
            value={form.maxParticipants}
            onChange={(event) => update("maxParticipants", event.target.value)}
          />
        </label>
      </div>
      <div className="form-grid">
        <label>
          시작
          <input type="date" value={form.startDate} onChange={(event) => update("startDate", event.target.value)} />
        </label>
        <label>
          종료
          <input type="date" value={form.endDate} onChange={(event) => update("endDate", event.target.value)} />
        </label>
      </div>
      <button className="primary-button" disabled={saving}>
        {saving ? "저장 중" : submitLabel}
      </button>
    </form>
  );
}

function BottomSheet({ title, children, onClose }) {
  return (
    <div className="sheet-backdrop" role="presentation">
      <section className="bottom-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="닫기">
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const element = document.createElement("textarea");
  element.value = text;
  document.body.appendChild(element);
  element.select();
  document.execCommand("copy");
  element.remove();
}
