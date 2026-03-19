import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { generateText } from "ai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { requireAuth } from "../server.js";
import "../server-types.js";

const routes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: { text: string } }>(
    "/api/translate",
    async (req, reply) => {
      const userId = requireAuth(req, reply);
      if (userId === null) return;

      const { text } = req.body;
      if (!text || !text.trim()) {
        return reply.code(400).send({ error: "text is required" });
      }

      try {
        const deepseek = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY ?? "" });
        const { text: translatedText } = await generateText({
          model: deepseek("deepseek-chat"),
          prompt: `You are a precise translation assistant for software development.
Translate the following text into English. This text is an instruction for an AI coding agent.

Rules:
1. Preserve ALL technical terms exactly (function names, variable names, file paths, CLI commands, package names, code snippets)
2. Preserve all markdown formatting, code blocks, and special characters
3. If the text is already in English, return it EXACTLY as-is
4. Return ONLY the translated text, nothing else

Text:
${text}`,
        });

        return reply.code(200).send({ translatedText: translatedText.trim() });
      } catch (error) {
        console.error("[translate] Translation failed:", error);
        return reply.code(500).send({ error: "Translation failed" });
      }
    }
  );
};

export default fp(routes, { name: "translate-routes" });
