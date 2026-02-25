import { ProxyAgent, Agent, type Dispatcher } from "undici";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import type http from "http";

export interface ProxyConfig {
  type: "none" | "http" | "socks5";
  host: string;
  port: number;
}

const DEFAULT_CONFIG: ProxyConfig = { type: "none", host: "", port: 0 };

export class ProxyManager {
  private config: ProxyConfig = { ...DEFAULT_CONFIG };
  private fetchDispatcher: Dispatcher | undefined;
  private wsAgent: http.Agent | undefined;

  updateConfig(config: ProxyConfig): void {
    this.config = { ...config };

    // Dispose previous dispatcher if possible
    this.fetchDispatcher = undefined;
    this.wsAgent = undefined;

    if (config.type === "none") {
      return;
    }

    const proxyUrl = config.type === "http"
      ? `http://${config.host}:${config.port}`
      : `socks5://${config.host}:${config.port}`;

    if (config.type === "http") {
      this.fetchDispatcher = new ProxyAgent({ uri: `http://${config.host}:${config.port}` });
      this.wsAgent = new HttpsProxyAgent(proxyUrl) as unknown as http.Agent;
    } else if (config.type === "socks5") {
      // For SOCKS5 fetch, use undici Agent with custom connect via socks-proxy-agent
      // SocksProxyAgent works with both HTTP and HTTPS
      this.fetchDispatcher = new ProxyAgent({ uri: `socks5://${config.host}:${config.port}` });
      this.wsAgent = new SocksProxyAgent(proxyUrl) as unknown as http.Agent;
    }
  }

  getFetchDispatcher(): Dispatcher | undefined {
    return this.fetchDispatcher;
  }

  getWsOptions(): { agent?: http.Agent } {
    if (!this.wsAgent) return {};
    return { agent: this.wsAgent };
  }

  getConfig(): ProxyConfig {
    return { ...this.config };
  }
}
