import { promises as fs } from "node:fs";
import path from "node:path";

const dataRoot = path.join(process.cwd(), "data");
export const usersDir = path.join(dataRoot, "users");
export const plansDir = path.join(dataRoot, "plans");
export const usersFile = path.join(usersDir, "users.json");
export const kakaoFile = path.join(usersDir, "kakao.json");
export const plansIndexFile = path.join(plansDir, "index.json");

let writeQueue = Promise.resolve();

export async function initStorage() {
  await fs.mkdir(usersDir, { recursive: true });
  await fs.mkdir(plansDir, { recursive: true });
  await ensureJson(usersFile, { users: [] });
  await ensureJson(kakaoFile, { accounts: [], notifications: [] });
  await ensureJson(plansIndexFile, { plans: [] });
}

export function planFile(planId) {
  if (!/^plan_[a-z0-9]+$/.test(planId)) {
    throw new Error("Invalid plan id");
  }

  return path.join(plansDir, `${planId}.json`);
}

export async function readJson(file, fallback) {
  try {
    const content = await fs.readFile(file, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

export async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function withWriteLock(task) {
  const next = writeQueue.then(task, task);
  writeQueue = next.catch(() => {});
  return next;
}

async function ensureJson(file, fallback) {
  try {
    await fs.access(file);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    await writeJson(file, fallback);
  }
}
