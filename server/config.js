import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

/** 常见 OpenAI 兼容服务商预设 */
const PRESETS = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    keyHint: 'https://platform.deepseek.com/api_keys',
  },
  dashscope: {
    label: '阿里通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    keyHint: 'https://bailian.console.aliyun.com/',
  },
  moonshot: {
    label: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    keyHint: 'https://platform.moonshot.cn/console/api-keys',
  },
  zhipu: {
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    keyHint: 'https://open.bigmodel.cn/',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyHint: 'https://platform.openai.com/api-keys',
  },
  siliconflow: {
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    keyHint: 'https://cloud.siliconflow.cn/account/ak',
  },
};

const provider = (process.env.LLM_PROVIDER || 'deepseek').trim().toLowerCase();
const preset = PRESETS[provider] || PRESETS.deepseek;

const apiKey = (process.env.LLM_API_KEY || '').trim();

export const config = {
  root: ROOT,
  port: Number(process.env.PORT || 4317),
  dbPath: process.env.DB_PATH
    ? path.resolve(ROOT, process.env.DB_PATH)
    : path.join(ROOT, 'data', 'grading.sqlite'),
  seedDemo: process.env.SEED_DEMO !== '0',
  llm: {
    provider,
    providerLabel: preset.label,
    baseUrl: (process.env.LLM_BASE_URL || preset.baseUrl).replace(/\/+$/, ''),
    model: process.env.LLM_MODEL || preset.model,
    apiKey,
    keyConfigured: Boolean(apiKey) && apiKey !== 'sk-your-key-here',
    keyHint: preset.keyHint,
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 60000),
    temperature: Number(process.env.LLM_TEMPERATURE ?? 0),
  },
};

export const publicMeta = () => ({
  provider: config.llm.provider,
  providerLabel: config.llm.providerLabel,
  model: config.llm.model,
  keyConfigured: config.llm.keyConfigured,
  keyHint: config.llm.keyHint,
  temperature: config.llm.temperature,
});
