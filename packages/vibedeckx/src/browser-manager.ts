/**
 * BrowserManager — manages server-side Playwright browser instances.
 *
 * One browser session per project. Provides page automation (navigate, click, fill)
 * and captures errors via CDP event listeners. Errors are forwarded to a callback
 * (wired to ChatSessionManager for [Browser Event] injection).
 */

import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";

// ============ Types ============

export interface BrowserError {
  type: "js_error" | "console_error" | "network_error" | "crash";
  message: string;
  source?: string;
  stack?: string;
  timestamp: number;
  url?: string;
  status?: number;
}

export interface BrowserSessionInfo {
  id: string;
  projectId: string;
  branch: string | null;
  url: string;
  status: "starting" | "running" | "stopped";
}

interface BrowserSession {
  id: string;
  projectId: string;
  branch: string | null;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  url: string;
  status: "starting" | "running" | "stopped";
  errors: BrowserError[];
  errorCallback: ((error: BrowserError) => void) | null;
}

const MAX_ERRORS = 100;

// ============ Manager ============

export class BrowserManager {
  private sessions = new Map<string, BrowserSession>();
  /** projectId -> sessionId */
  private projectIndex = new Map<string, string>();

  async startSession(
    projectId: string,
    branch: string | null,
    errorCallback?: (error: BrowserError) => void,
  ): Promise<BrowserSessionInfo> {
    // Return existing session if one exists
    const existingId = this.projectIndex.get(projectId);
    if (existingId) {
      const existing = this.sessions.get(existingId);
      if (existing && existing.status === "running") {
        return this.toInfo(existing);
      }
    }

    const id = `browser-${projectId}-${Date.now()}`;

    const browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
      ],
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    const session: BrowserSession = {
      id,
      projectId,
      branch,
      browser,
      context,
      page,
      url: "",
      status: "running",
      errors: [],
      errorCallback: errorCallback ?? null,
    };

    this.attachErrorListeners(session);

    this.sessions.set(id, session);
    this.projectIndex.set(projectId, id);

    console.log(`[BrowserManager] Started session ${id} for project=${projectId}`);
    return this.toInfo(session);
  }

  async stopSession(projectId: string): Promise<boolean> {
    const sessionId = this.projectIndex.get(projectId);
    if (!sessionId) return false;

    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.status = "stopped";

    try {
      await session.context.close();
      await session.browser.close();
    } catch (err) {
      console.error(`[BrowserManager] Error closing session ${sessionId}:`, err);
    }

    this.sessions.delete(sessionId);
    this.projectIndex.delete(projectId);
    console.log(`[BrowserManager] Stopped session ${sessionId}`);
    return true;
  }

  getSession(projectId: string): BrowserSessionInfo | null {
    const sessionId = this.projectIndex.get(projectId);
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return this.toInfo(session);
  }

  /** Get the raw Playwright Page for tool execution. Internal use only. */
  getPage(projectId: string): Page | null {
    const sessionId = this.projectIndex.get(projectId);
    if (!sessionId) return null;
    return this.sessions.get(sessionId)?.page ?? null;
  }

  async navigate(projectId: string, url: string): Promise<{ title: string; url: string } | null> {
    const sessionId = this.projectIndex.get(projectId);
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    try {
      await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      session.url = session.page.url();
      const title = await session.page.title();
      return { title, url: session.url };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Navigation failed";
      throw new Error(message);
    }
  }

  async shutdown(): Promise<void> {
    const projectIds = [...this.projectIndex.keys()];
    for (const projectId of projectIds) {
      await this.stopSession(projectId);
    }
    console.log("[BrowserManager] Shutdown complete");
  }

  // ---- Error capture ----

  private attachErrorListeners(session: BrowserSession): void {
    const { page } = session;

    page.on("pageerror", (error) => {
      this.reportError(session, {
        type: "js_error",
        message: error.message,
        stack: error.stack,
        timestamp: Date.now(),
      });
    });

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        this.reportError(session, {
          type: "console_error",
          message: msg.text(),
          timestamp: Date.now(),
        });
      }
    });

    page.on("requestfailed", (request) => {
      this.reportError(session, {
        type: "network_error",
        message: `${request.method()} ${request.url()} -- ${request.failure()?.errorText ?? "unknown"}`,
        url: request.url(),
        timestamp: Date.now(),
      });
    });

    page.on("crash", () => {
      this.reportError(session, {
        type: "crash",
        message: "Browser tab crashed",
        timestamp: Date.now(),
      });
    });
  }

  private reportError(session: BrowserSession, error: BrowserError): void {
    session.errors.push(error);
    if (session.errors.length > MAX_ERRORS) {
      session.errors.shift();
    }
    session.errorCallback?.(error);
  }

  private toInfo(session: BrowserSession): BrowserSessionInfo {
    return {
      id: session.id,
      projectId: session.projectId,
      branch: session.branch,
      url: session.url,
      status: session.status,
    };
  }
}
