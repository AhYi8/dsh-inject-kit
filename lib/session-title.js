// 会话标题（AI 会话标题）配置规范化：Host 与单测共用同一份实现。
// 背景：AI 会话标题由可选 bundle dsh-experimental-session-titles-bundle 的
// session-title-llm 条目提供（first-prompt 提供方）。该条目的 config 是整体
// 替换且字段全部必填（见 @deepseek-ai/dsh-session-title-first-prompt-llm 的
// Schema），因此在任何写入/下发路径上都必须产出一份完整、合法的 config。

// 与 @local/session-title-512k 补丁包保持一致的默认值：把输入字节预算从
// 原生 4096 提到 524288（512K），使超长交接 prompt 不再因超限回退标题。
export const SESSION_TITLE_DEFAULTS = Object.freeze({
  targetWords: 5,
  targetCjkCharacters: 10,
  maxInputBytes: 524288,
  maxOutputTokens: 4096,
  timeoutMs: 60000,
});

export const SESSION_TITLE_FIELDS = Object.freeze([
  'targetWords',
  'targetCjkCharacters',
  'maxInputBytes',
  'maxOutputTokens',
  'timeoutMs',
]);

/**
 * 规范化用户输入的会话标题配置。
 * 传入 null/undefined 或字段缺失时取默认值；字段存在但非法（非正整数）或
 * 结构错误（数组、其他原始值）时抛错——写入路径应先校验再落盘，不允许静默
 * 回退默认值掩盖用户笔误。
 * @param {unknown} raw - 用户输入的原始配置对象。
 * @returns {Record<string, number>} 完整的五字段正整数配置。
 */
export function normalizeSessionTitleConfig(raw) {
  // null/undefined 视为「未配置」，整体取默认值；数组与其他原始值属于结构性
  // 错误，必须显式拒绝——读取路径（历史文件损坏）由调用方 try/catch 兜底。
  if (raw === null || raw === undefined) return normalizeSessionTitleConfig({});
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`session-title: 配置必须是对象，收到 ${Array.isArray(raw) ? '数组' : typeof raw}`);
  }
  const source = raw;
  const result = {};
  for (const field of SESSION_TITLE_FIELDS) {
    const value = source[field] ?? SESSION_TITLE_DEFAULTS[field];
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`session-title: ${field} 必须是正整数，收到 ${JSON.stringify(value)}`);
    }
    result[field] = value;
  }
  return result;
}

// 目标提供方插件（first-prompt 提供方）在 cordis registry 中的运行时名。
// 由 cordis plugin({name, apply, ...}) 的 name 字段保留而来。
const SESSION_TITLE_PLUGIN_NAME = 'session-title-first-prompt-llm';

/**
 * 把会话标题配置下发到已挂载的 first-prompt 提供方。
 *
 * 原理：提供方在 apply 时一次性固化 config（deepFreeze），改 patch 文件不会
 * 影响运行中的实例；cordis 的 fiber.update(config) 会校验新 config 并重启
 * 插件，因此这里是设置项即时生效的唯一通道。目标条目由可选 bundle
 * dsh-experimental-session-titles-bundle 提供：未启用该 bundle 时 registry 里
 * 找不到目标运行时，属正常情况，静默返回（cordis 的 patch 层负责启用与兜底）。
 * 本模块不依赖任何 peer 包，Host 与单测共用同一份实现。
 * @param {object} ctx - cordis 上下文（可访问 registry）。
 * @param {Record<string, number>} settings - 已保存的完整五字段配置。
 * @param {(message: string) => void} [log] - 详细日志出口。
 * @returns {{found: boolean, updated: number, errors: string[]}} 应用结果。
 */
export function applySessionTitleConfig(ctx, settings, log = () => {}) {
  const result = { found: false, updated: 0, errors: [] };
  const registry = ctx?.registry;
  if (!registry || typeof registry.values !== 'function') return result;
  const config = normalizeSessionTitleConfig(settings);
  for (const runtime of registry.values()) {
    if (runtime?.name !== SESSION_TITLE_PLUGIN_NAME) continue;
    result.found = true;
    for (const fiber of runtime.fibers) {
      try {
        // config 是整体替换：必须下发全部必填字段，不能只发变更项
        fiber.update({ ...config });
        result.updated += 1;
        log('session-title fiber updated:', fiber.name ?? '(fiber)');
      } catch (error) {
        // 校验失败（如 timeoutMs 超上限）不拖垮本插件，把错误带回给调用方展示
        result.errors.push(String(error?.message || error));
      }
    }
  }
  return result;
}
