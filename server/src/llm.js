// LLM 网关客户端（OpenAI 兼容）：仅用于"自动标题"。
// 设计红线：调用方负责绝不把 isSensitive 的 clip 传进来——secret 永不出本机。
// 网关不可用 / 未配置 / 超时 / 任意错误 → generateTitle 返回 null，核心功能不受影响（优雅降级）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_URL = 'http://127.0.0.1:7421';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_TIMEOUT_MS = 12_000;
const TITLE_INPUT_CHARS = 4000; // 送给模型的内容上限，控制成本与延迟
const TITLE_MAX_CHARS = 80; // 标题落库长度上限

// 从环境变量解析网关配置；token 缺省时尝试读 ~/.config/llm-gateway/token。
export function resolveLlmConfig(env = process.env) {
  const url = (env.LLM_GATEWAY_URL || DEFAULT_URL).replace(/\/+$/, '');
  let token = env.LLM_GATEWAY_TOKEN || '';
  if (!token) {
    try {
      const f = path.join(os.homedir(), '.config', 'llm-gateway', 'token');
      token = fs.readFileSync(f, 'utf8').trim();
    } catch {
      /* 没有就保持空，enabled=false */
    }
  }
  return {
    url,
    token,
    model: env.LLM_TITLE_MODEL || DEFAULT_MODEL,
    timeoutMs: Number(env.LLM_TIMEOUT_MS) > 0 ? Number(env.LLM_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
  };
}

function cleanTitle(raw) {
  if (typeof raw !== 'string') return null;
  let t = raw.trim();
  if (!t) return null;
  // 去掉模型常见的包裹引号 / 前缀 / 多余空白与换行
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/^["'“”『「]+|["'“”』」]+$/g, '').trim();
  t = t.replace(/^(标题|title)\s*[:：]\s*/i, '').trim();
  if (!t) return null;
  return t.length > TITLE_MAX_CHARS ? t.slice(0, TITLE_MAX_CHARS).trim() : t;
}

const SYSTEM_PROMPT =
  '你是一个为剪贴板内容起标题的助手。根据用户给出的文本，生成一个不超过 8 个字（中文）或 6 个单词（英文）的简洁标题，概括其主旨。只输出标题本身，不要引号、不要标点结尾、不要任何解释。';

/**
 * 创建网关客户端。返回 { enabled, model, generateTitle(content) }。
 * generateTitle 永不抛错：失败一律 null。
 */
export function createLlmClient(cfg = resolveLlmConfig(), { fetchImpl = globalThis.fetch } = {}) {
  const enabled = !!cfg.token && typeof fetchImpl === 'function';

  async function generateTitle(content) {
    if (!enabled) return null;
    if (typeof content !== 'string' || content.trim().length === 0) return null;
    const input = content.length > TITLE_INPUT_CHARS ? content.slice(0, TITLE_INPUT_CHARS) : content;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetchImpl(`${cfg.url}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.token}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: input },
          ],
          max_tokens: 32,
          temperature: 0.3,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = await res.json();
      return cleanTitle(data?.choices?.[0]?.message?.content);
    } catch {
      return null; // 超时 / 网络错误 / 解析错误 一律降级
    } finally {
      clearTimeout(timer);
    }
  }

  return { enabled, model: cfg.model, url: cfg.url, generateTitle };
}
