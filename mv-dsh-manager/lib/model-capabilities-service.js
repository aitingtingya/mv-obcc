// Model capability settings bridge for DSH's model-catalog namespaces.
//
// This module deliberately owns the complete settings/LLM contract. The
// manager entry point only delegates the two private HTTP routes to it, and no
// other manager feature needs to know how a model profile is represented.
//
// Two namespaces own model catalogs and their field sets do not overlap:
//   llm-pi-ai      — hand-declared routes: input / reasoningEfforts / compat.
//   llm-deepseek   — the adapter's own section: inputModalities / imagePixelBudget /
//                    imageMaxBytes / description, and no compat at all.
// Every read and write below is keyed by the namespace the descriptor came
// from, so a model row can never be written into the other namespace.

import { resolveModelSettings } from '../../mv-dsh-compat/lib/host.js';

const SETTINGS_NS = 'llm-pi-ai';
const DEEPSEEK_NS = 'llm-deepseek';
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const MODALITIES = ['text', 'image'];
const THINKING_FORMATS = [
  'openai',
  'deepseek',
  'openrouter',
  'together',
  'zai',
  'qwen',
  'chat-template',
  'qwen-chat-template',
  'string-thinking',
  'ant-ling',
];
const MAX_TOKENS_FIELDS = ['max_completion_tokens', 'max_tokens'];
const CACHE_CONTROL_FORMATS = ['anthropic'];
const CHAT_TEMPLATE_VARS = ['thinking.enabled', 'thinking.effort'];
const BOOLEAN_COMPAT_FIELDS = [
  'supportsStore',
  'supportsDeveloperRole',
  'supportsReasoningEffort',
  'supportsUsageInStreaming',
  'requiresToolResultName',
  'requiresAssistantAfterToolResult',
  'requiresThinkingAsText',
  'requiresReasoningContentOnAssistantMessages',
  'supportsStrictMode',
  'supportsLongCacheRetention',
  'supportsEagerToolInputStreaming',
  'supportsCacheControlOnTools',
  'supportsTemperature',
  'forceAdaptiveThinking',
  'allowEmptySignature',
  'supportsStrictTools',
];
const ALPHA_BOOLEAN_COMPAT_FIELDS = [
  'supportsFinishReason',
  'supportsThinkingTokenBudget',
];
const ALL_BOOLEAN_COMPAT_FIELDS = [...BOOLEAN_COMPAT_FIELDS, ...ALPHA_BOOLEAN_COMPAT_FIELDS];
const ENUM_COMPAT_FIELDS = {
  thinkingFormat: THINKING_FORMATS,
  maxTokensField: MAX_TOKENS_FIELDS,
  cacheControlFormat: CACHE_CONTROL_FORMATS,
};
const PREVIEW_COMPAT_FIELDS = [
  ...BOOLEAN_COMPAT_FIELDS,
  ...Object.keys(ENUM_COMPAT_FIELDS),
  'chatTemplateKwargs',
];
const OBJECT_COMPAT_FIELDS = ['chatTemplateKwargs', 'chatTemplateArgs'];
const COMPAT_FIELDS = [
  ...ALL_BOOLEAN_COMPAT_FIELDS,
  ...Object.keys(ENUM_COMPAT_FIELDS),
  ...OBJECT_COMPAT_FIELDS,
];
const MODEL_FIELDS = ['name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts'];
const BUILTIN_MODEL_FIELDS = new Set(MODEL_FIELDS);
const CUSTOM_MODEL_FIELDS = new Set(['input', 'reasoningEfforts']);
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

// ── llm-deepseek family (dsh's own model catalog) ──
// Mirrors `catalogModel` in @deepseek-ai/dsh-llm-deepseek. Nothing here exists
// in llm-pi-ai and nothing from llm-pi-ai may enter it.
const DEEPSEEK_MODEL_FIELDS = [
  'name',
  'description',
  'contextWindow',
  'maxTokens',
  'inputModalities',
  'imagePixelBudget',
  'imageMaxBytes',
];
const DEEPSEEK_MODEL_FIELD_SET = new Set(DEEPSEEK_MODEL_FIELDS);
const DEEPSEEK_REQUIRED_SCHEMA_FIELDS = ['models', 'inputModalities', 'contextWindow', 'maxTokens'];
const DEEPSEEK_CAPACITY_FIELDS = ['contextWindow', 'maxTokens'];
const DEEPSEEK_IMAGE_FIELDS = ['imagePixelBudget', 'imageMaxBytes'];
// The adapter's own defaults, from @deepseek-ai/dsh-llm-deepseek.
const DEEPSEEK_DEFAULTS = Object.freeze({
  contextWindow: 1_000_000,
  maxTokens: 256_000,
  imagePixelBudget: 640_000,
  lowDetailImagePixelBudget: 512 * 512,
  imageMaxBytes: 1_048_576,
});

export class ModelCapabilitiesError extends Error {
  constructor(message, status = 400, code = 'invalid-model-capabilities') {
    super(message);
    this.name = 'ModelCapabilitiesError';
    this.status = status;
    this.code = code;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function objectAt(source, path) {
  let current = source;
  for (const segment of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return isPlainObject(current) ? current : undefined;
}

function profileAt(descriptor, layer, provider) {
  return objectAt(descriptor[layer], ['providers', provider]);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function publicModelFields(source) {
  if (!isPlainObject(source)) return {};
  const result = {};
  for (const field of MODEL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, field)) result[field] = clone(source[field]);
  }
  if (isPlainObject(source.compat)) result.compat = clone(source.compat);
  return result;
}

/** The editable projection of one llm-deepseek catalog entry. */
function publicDeepseekModelFields(source) {
  if (!isPlainObject(source)) return {};
  const result = {};
  for (const field of DEEPSEEK_MODEL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, field)) result[field] = clone(source[field]);
  }
  return result;
}

function schemaSupport(descriptor) {
  const serialized = JSON.stringify(descriptor?.schema ?? null);
  const has = (field) => serialized.includes(`"${field}"`);
  const required = ['models', 'modelOverrides', 'input', 'reasoningEfforts', 'compat', ...PREVIEW_COMPAT_FIELDS];
  const missing = required.filter((field) => !has(field));
  const availableBooleanCompatFields = ALL_BOOLEAN_COMPAT_FIELDS
    .filter((field) => has(field));
  const availableObjectCompatFields = OBJECT_COMPAT_FIELDS.filter((field) => has(field));
  const availableCompatFields = [
    ...availableBooleanCompatFields,
    ...Object.keys(ENUM_COMPAT_FIELDS).filter((field) => has(field)),
    ...availableObjectCompatFields,
  ];
  return {
    supported: missing.length === 0,
    missing,
    fields: Object.fromEntries([...new Set([...required, ...COMPAT_FIELDS])].map((field) => [field, has(field)])),
    compatFields: availableCompatFields,
    booleanCompatFields: availableBooleanCompatFields,
    objectCompatFields: availableObjectCompatFields,
  };
}

function services(ctx) {
  const { settings, llm } = resolveModelSettings(ctx);
  if (!settings || typeof settings.describe !== 'function' || typeof settings.mutate !== 'function') {
    throw new ModelCapabilitiesError('DSH settings service is unavailable.', 503, 'settings-unavailable');
  }
  if (!llm) throw new ModelCapabilitiesError('DSH LLM service is unavailable.', 503, 'llm-unavailable');
  return { settings, llm };
}

function settingsDescriptor(settings, ns = SETTINGS_NS) {
  const descriptor = settings.describe({ redactSecrets: true })
    .find((entry) => entry?.ns === ns);
  if (!descriptor) {
    throw new ModelCapabilitiesError(
      `This DSH version does not expose the ${ns} settings namespace.`,
      409,
      'unsupported-dsh-version',
    );
  }
  return descriptor;
}

/** Every model-catalog namespace this DSH exposes, keyed by namespace. */
function settingsDescriptors(settings) {
  const found = new Map();
  for (const ns of [SETTINGS_NS, DEEPSEEK_NS]) {
    const descriptor = settings.describe({ redactSecrets: true }).find((entry) => entry?.ns === ns);
    if (descriptor) found.set(ns, descriptor);
  }
  return found;
}

/** The pi-ai route directory: registered routes plus everything the user configured. */
function piAiDirectoryEntries(llm, descriptor) {
  const directory = typeof llm.listConfigurableProviders === 'function'
    ? llm.listConfigurableProviders().filter((entry) => entry?.settingsNs === SETTINGS_NS)
    : [];
  const known = new Set(directory.map((entry) => entry.provider));
  const configured = objectAt(descriptor.value, ['providers']) ?? {};
  for (const provider of Object.keys(configured)) {
    if (known.has(provider)) continue;
    directory.push({
      provider,
      displayName: typeof configured[provider]?.displayName === 'string'
        ? configured[provider].displayName
        : provider,
      settingsNs: SETTINGS_NS,
      settingsPath: ['providers', provider],
      declared: true,
    });
  }
  return directory;
}

/**
 * Every model-catalog entry across every namespace this DSH exposes. Each entry
 * carries its own `settingsNs`, and that — never a guess about on-screen text —
 * is what tells a writer which settings document section it may touch.
 */
function directoryEntries(llm, descriptors) {
  const directory = [];
  const piAi = descriptors.get(SETTINGS_NS);
  if (piAi) directory.push(...piAiDirectoryEntries(llm, piAi));
  const deepseek = descriptors.get(DEEPSEEK_NS);
  if (deepseek) {
    const registered = typeof llm.listConfigurableProviders === 'function'
      ? llm.listConfigurableProviders().filter((entry) => entry?.settingsNs === DEEPSEEK_NS)
      : [];
    if (registered.length > 0) {
      for (const entry of registered) {
        directory.push({ ...entry, settingsNs: DEEPSEEK_NS, settingsPath: entry.settingsPath ?? [] });
      }
    } else {
      directory.push({
        provider: 'deepseek',
        displayName: 'DeepSeek',
        settingsNs: DEEPSEEK_NS,
        settingsPath: [],
        declared: true,
      });
    }
  }
  return directory;
}

/** The schema-derived switchboard of the llm-deepseek catalog model. */
function deepseekSupport(descriptor) {
  const serialized = JSON.stringify(descriptor?.schema ?? null);
  const has = (field) => serialized.includes(`"${field}"`);
  const missing = DEEPSEEK_REQUIRED_SCHEMA_FIELDS.filter((field) => !has(field));
  return {
    supported: missing.length === 0,
    missing,
    fields: Object.fromEntries(DEEPSEEK_MODEL_FIELDS.map((field) => [field, has(field)])),
    compatFields: [],
    booleanCompatFields: [],
    objectCompatFields: [],
  };
}

function assertIdentity(value, label) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > 512 || value.includes('\0')) {
    throw new ModelCapabilitiesError(`${label} must be a non-empty, trimmed string.`);
  }
  return value;
}

function assertAllowedObjectKeys(value, label) {
  for (const key of Object.keys(value)) {
    if (key.length === 0 || key.length > 128 || FORBIDDEN_OBJECT_KEYS.has(key) || key.includes('\0')) {
      throw new ModelCapabilitiesError(`${label} contains an invalid key.`);
    }
  }
}

function validateInput(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ModelCapabilitiesError('input must contain at least one modality.');
  }
  const unique = new Set(value);
  if (unique.size !== value.length || value.some((entry) => !MODALITIES.includes(entry))) {
    throw new ModelCapabilitiesError('input must contain unique text/image modalities.');
  }
  return [...value];
}

function validateReasoningEfforts(value) {
  if (value === false) return false;
  if (!isPlainObject(value)) {
    throw new ModelCapabilitiesError('reasoningEfforts must be false or a level mapping.');
  }
  assertAllowedObjectKeys(value, 'reasoningEfforts');
  const entries = Object.entries(value);
  if (entries.length === 0 || !entries.some(([level]) => level !== 'off')) {
    throw new ModelCapabilitiesError('A reasoning model needs at least one non-off level.');
  }
  const result = {};
  for (const [level, wireValue] of entries) {
    if (!THINKING_LEVELS.includes(level)) {
      throw new ModelCapabilitiesError(`Unsupported reasoning level: ${level}`);
    }
    if (level === 'off' && (wireValue === null || wireValue === '')) {
      result[level] = null;
      continue;
    }
    if (typeof wireValue !== 'string' || wireValue.length === 0) {
      throw new ModelCapabilitiesError(`Reasoning level ${level} needs a provider value.`);
    }
    result[level] = wireValue;
  }
  return result;
}

function validateChatTemplateKwargs(value) {
  if (!isPlainObject(value)) throw new ModelCapabilitiesError('chatTemplateKwargs must be an object.');
  assertAllowedObjectKeys(value, 'chatTemplateKwargs');
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') {
      result[key] = entry;
      continue;
    }
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      result[key] = entry;
      continue;
    }
    if (isPlainObject(entry)
      && CHAT_TEMPLATE_VARS.includes(entry.$var)
      && (entry.omitWhenOff === undefined || typeof entry.omitWhenOff === 'boolean')
      && Object.keys(entry).every((field) => field === '$var' || field === 'omitWhenOff')) {
      result[key] = {
        $var: entry.$var,
        ...(entry.omitWhenOff === undefined ? {} : { omitWhenOff: entry.omitWhenOff }),
      };
      continue;
    }
    throw new ModelCapabilitiesError(`chatTemplateKwargs.${key} has an unsupported value.`);
  }
  return result;
}

function validateCompat(value) {
  if (!isPlainObject(value)) throw new ModelCapabilitiesError('compat must be an object.');
  const result = {};
  for (const [field, entry] of Object.entries(value)) {
    if (!COMPAT_FIELDS.includes(field)) {
      throw new ModelCapabilitiesError(`Unsupported compat field: ${field}`);
    }
    if (ALL_BOOLEAN_COMPAT_FIELDS.includes(field)) {
      if (typeof entry !== 'boolean') throw new ModelCapabilitiesError(`${field} must be true or false.`);
      result[field] = entry;
      continue;
    }
    if (OBJECT_COMPAT_FIELDS.includes(field)) {
      result[field] = validateChatTemplateKwargs(entry);
      continue;
    }
    if (!ENUM_COMPAT_FIELDS[field].includes(entry)) {
      throw new ModelCapabilitiesError(`${field} has an unsupported value.`);
    }
    result[field] = entry;
  }
  return result;
}

function validateModelField(field, value, kind) {
  const allowed = kind === 'builtin' ? BUILTIN_MODEL_FIELDS : CUSTOM_MODEL_FIELDS;
  if (!allowed.has(field)) throw new ModelCapabilitiesError(`${field} cannot be changed for a ${kind} model.`);
  if (field === 'input') return validateInput(value);
  if (field === 'reasoningEfforts') return validateReasoningEfforts(value);
  if (field === 'name') {
    if (typeof value !== 'string' || value.length === 0) throw new ModelCapabilitiesError('name cannot be empty.');
    return value;
  }
  if (field === 'contextWindow' || field === 'maxTokens') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ModelCapabilitiesError(`${field} must be a positive integer.`);
    }
    return value;
  }
  throw new ModelCapabilitiesError(`Unsupported model field: ${field}`);
}

function validateChange(raw) {
  if (!isPlainObject(raw)) throw new ModelCapabilitiesError('Each model change must be an object.');
  const kind = raw.kind;
  if (kind !== 'custom' && kind !== 'builtin') throw new ModelCapabilitiesError('Model kind must be custom or builtin.');
  const modelId = assertIdentity(raw.modelId, 'modelId');
  const set = isPlainObject(raw.set) ? raw.set : {};
  const unset = Array.isArray(raw.unset) ? raw.unset : [];
  const compat = isPlainObject(raw.compat) ? validateCompat(raw.compat) : {};
  const compatUnset = Array.isArray(raw.compatUnset) ? raw.compatUnset : [];
  const allowed = kind === 'builtin' ? BUILTIN_MODEL_FIELDS : CUSTOM_MODEL_FIELDS;
  const cleanSet = {};
  for (const [field, value] of Object.entries(set)) cleanSet[field] = validateModelField(field, value, kind);
  for (const field of unset) {
    if (typeof field !== 'string' || !allowed.has(field)) {
      throw new ModelCapabilitiesError(`Unsupported unset field for ${kind}: ${String(field)}`);
    }
  }
  for (const field of compatUnset) {
    if (typeof field !== 'string' || !COMPAT_FIELDS.includes(field)) {
      throw new ModelCapabilitiesError(`Unsupported compat unset field: ${String(field)}`);
    }
  }
  if (new Set(unset).size !== unset.length || new Set(compatUnset).size !== compatUnset.length) {
    throw new ModelCapabilitiesError('Unset field lists cannot contain duplicates.');
  }
  return { kind, modelId, set: cleanSet, unset, compat, compatUnset };
}

function validateDeepseekModalities(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ModelCapabilitiesError('inputModalities must contain at least one modality.');
  }
  const unique = new Set(value);
  if (unique.size !== value.length || value.some((entry) => !MODALITIES.includes(entry))) {
    throw new ModelCapabilitiesError('inputModalities must contain unique text/image modalities.');
  }
  return [...value];
}

function validateDeepseekCapacity(field, value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ModelCapabilitiesError(`${field} must be a positive integer.`);
  }
  return value;
}

function validateDeepseekImagePixelBudget(value) {
  if (value === 'low') return value;
  return validateDeepseekCapacity('imagePixelBudget', value);
}

function validateDeepseekModelField(field, value) {
  if (!DEEPSEEK_MODEL_FIELD_SET.has(field)) {
    throw new ModelCapabilitiesError(`${field} is not a field of the llm-deepseek model catalog.`);
  }
  if (field === 'name') {
    if (typeof value !== 'string' || value.length === 0) throw new ModelCapabilitiesError('name cannot be empty.');
    return value;
  }
  if (field === 'description') {
    if (typeof value !== 'string') throw new ModelCapabilitiesError('description must be a string.');
    return value;
  }
  if (field === 'inputModalities') return validateDeepseekModalities(value);
  if (field === 'imagePixelBudget') return validateDeepseekImagePixelBudget(value);
  if (field === 'imageMaxBytes') return validateDeepseekCapacity(field, value);
  return validateDeepseekCapacity(field, value);
}

/**
 * Validate one llm-deepseek catalog change. The field set here is the adapter's
 * own; a pi-ai field (`input` / `reasoningEfforts` / `compat`) is refused rather
 * than translated, because the two namespaces do not share those fields.
 */
function validateDeepseekChange(raw) {
  if (!isPlainObject(raw)) throw new ModelCapabilitiesError('Each model change must be an object.');
  const kind = raw.kind === undefined ? 'catalog' : raw.kind;
  if (kind !== 'catalog' && kind !== 'custom' && kind !== 'builtin') {
    throw new ModelCapabilitiesError('Model kind must be catalog, custom, or builtin.');
  }
  const modelId = assertIdentity(raw.modelId, 'modelId');
  const set = isPlainObject(raw.set) ? raw.set : {};
  const unset = Array.isArray(raw.unset) ? raw.unset : [];
  const cleanSet = {};
  for (const [field, value] of Object.entries(set)) cleanSet[field] = validateDeepseekModelField(field, value);
  for (const field of unset) {
    if (typeof field !== 'string' || !DEEPSEEK_MODEL_FIELD_SET.has(field)) {
      throw new ModelCapabilitiesError(`Unsupported unset field for llm-deepseek: ${String(field)}`);
    }
  }
  if (new Set(unset).size !== unset.length) {
    throw new ModelCapabilitiesError('Unset field lists cannot contain duplicates.');
  }
  if (unset.some((field) => Object.prototype.hasOwnProperty.call(cleanSet, field))) {
    throw new ModelCapabilitiesError('A field cannot be set and unset in the same change.');
  }
  return { kind, modelId, set: cleanSet, unset };
}

/** Refuse a change that would add image limits to a model being made text-only. */
function assertDeepseekImageCoherence(current, set) {
  const setsModalities = Object.prototype.hasOwnProperty.call(set, 'inputModalities');
  const setsImageField = DEEPSEEK_IMAGE_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(set, field));
  if (!setsImageField) return;
  const modalities = setsModalities ? set.inputModalities : current.inputModalities;
  const keepsImage = Array.isArray(modalities) ? modalities.includes('image') : false;
  if (keepsImage) return;
  throw new ModelCapabilitiesError(
    `A text-only model cannot declare ${DEEPSEEK_IMAGE_FIELDS.join(', ')}; keep "image" in inputModalities to use them.`,
  );
}

function patchDeepseekModel(current, change) {
  const next = isPlainObject(current) ? clone(current) : {};
  const modelId = typeof next.id === 'string' ? next.id : change.modelId;
  for (const field of change.unset) delete next[field];
  Object.assign(next, clone(change.set));
  // Absent means "text only" (the adapter's own default), so a model that is no
  // longer an image model never keeps limits the adapter would refuse.
  const modalities = Array.isArray(next.inputModalities) ? next.inputModalities : ['text'];
  if (!modalities.includes('image')) {
    for (const field of DEEPSEEK_IMAGE_FIELDS) delete next[field];
  }
  next.id = modelId;
  const ordered = {};
  for (const field of ['id', ...DEEPSEEK_MODEL_FIELDS]) {
    if (Object.prototype.hasOwnProperty.call(next, field)) ordered[field] = next[field];
  }
  return ordered;
}

/**
 * The llm-deepseek catalog a write starts from. The adapter resolves its whole
 * catalog from the composition layer, so a profile that never listed models
 * still has a complete one; that resolved list is what the editor shows and
 * therefore what a first capability edit must materialize. Unlike a pi-ai
 * route, nothing here needs re-resolving, so copying it writes no derived
 * state into the file.
 */
function deepseekWriteModels(descriptor) {
  if (Array.isArray(descriptor?.user?.models)) return clone(descriptor.user.models);
  if (Array.isArray(descriptor?.value?.models)) return clone(descriptor.value.models);
  if (Array.isArray(descriptor?.base?.models)) return clone(descriptor.base.models);
  return [];
}

/**
 * Apply changes to the llm-deepseek section's own `models` array. The write is a
 * single `set` of that array, so every model the user did not touch — and every
 * field of a touched model that the editor does not render, `description`
 * included — is carried over byte for byte.
 */
function transactionForDeepseek(descriptor, changes) {
  const models = deepseekWriteModels(descriptor);
  for (const change of changes) {
    const matches = models.flatMap((model, index) => isPlainObject(model) && model.id === change.modelId ? [index] : []);
    if (matches.length !== 1) {
      throw new ModelCapabilitiesError(
        matches.length === 0
          ? `Custom model ${change.modelId} no longer exists after the native save.`
          : `Custom model ${change.modelId} is duplicated; refusing an ambiguous write.`,
        409,
        'model-identity-changed',
      );
    }
    const index = matches[0];
    const current = models[index];
    if (!isPlainObject(current)) {
      throw new ModelCapabilitiesError(`Model ${change.modelId} is not a plain object.`);
    }
    assertDeepseekImageCoherence(current, change.set);
    models[index] = patchDeepseekModel(current, change);
  }
  return [{ op: 'set', path: ['models'], value: models }];
}

function assertChangesSupported(changes, support) {
  const available = new Set(support.compatFields);
  for (const change of changes) {
    for (const field of [...Object.keys(change.compat), ...change.compatUnset]) {
      if (!available.has(field)) {
        throw new ModelCapabilitiesError(`This DSH schema does not declare compat field: ${field}`);
      }
    }
  }
}

function patchModel(current, change) {
  const next = isPlainObject(current) ? clone(current) : {};
  for (const field of change.unset) delete next[field];
  Object.assign(next, change.set);
  const compat = isPlainObject(next.compat) ? clone(next.compat) : {};
  for (const field of change.compatUnset) delete compat[field];
  Object.assign(compat, change.compat);
  if (Object.keys(compat).length === 0) delete next.compat;
  else next.compat = compat;
  return next;
}

function providerSignature(descriptor, provider) {
  const profile = profileAt(descriptor, 'value', provider) ?? {};
  const models = Array.isArray(profile.models) ? profile.models : [];
  return JSON.stringify(models.map((model) => isPlainObject(model) ? model.id : null));
}

function isConflict(error) {
  return error?.name === 'SettingsConflictError'
    || error?.code === 'settings-conflict'
    || /revision|changed since|conflict/iu.test(String(error?.message ?? ''));
}

function transactionFor(descriptor, provider, changes) {
  const userProfile = profileAt(descriptor, 'user', provider) ?? {};
  const customChanges = changes.filter((change) => change.kind === 'custom');
  const builtinChanges = changes.filter((change) => change.kind === 'builtin');
  if (customChanges.length > 0 && builtinChanges.length > 0) {
    throw new ModelCapabilitiesError('Custom models and built-in overrides cannot be changed in one provider profile.');
  }
  if (customChanges.length > 0) {
    // Only the user layer may be rewritten: `descriptor.value` is the resolved
    // profile, so copying it back would bake adapter defaults into the file.
    if (!Array.isArray(userProfile.models)) {
      throw new ModelCapabilitiesError(
        'This provider\'s model list comes from the composition layer; save it once in the native editor before editing capabilities.',
        409,
        'model-list-not-user-owned',
      );
    }
    const models = clone(userProfile.models);
    for (const change of customChanges) {
      const matches = models.flatMap((model, index) => isPlainObject(model) && model.id === change.modelId ? [index] : []);
      if (matches.length !== 1) {
        throw new ModelCapabilitiesError(
          matches.length === 0
            ? `Custom model ${change.modelId} no longer exists after the native save.`
            : `Custom model ${change.modelId} is duplicated; refusing an ambiguous write.`,
          409,
          'model-identity-changed',
        );
      }
      models[matches[0]] = { ...patchModel(models[matches[0]], change), id: change.modelId };
    }
    return [{ op: 'set', path: ['providers', provider, 'models'], value: models }];
  }
  const currentOverrides = isPlainObject(userProfile.modelOverrides) ? clone(userProfile.modelOverrides) : {};
  for (const change of builtinChanges) {
    const next = patchModel(currentOverrides[change.modelId], change);
    if (Object.keys(next).length === 0) delete currentOverrides[change.modelId];
    else currentOverrides[change.modelId] = next;
  }
  return Object.keys(currentOverrides).length === 0
    ? [{ op: 'unset', path: ['providers', provider, 'modelOverrides'] }]
    : [{ op: 'set', path: ['providers', provider, 'modelOverrides'], value: currentOverrides }];
}

async function resolvedModel(llm, provider, listed) {
  try {
    const info = await llm.resolveModelInfo(provider, listed.id);
    return {
      id: listed.id,
      name: info.name ?? listed.name ?? listed.id,
      inputModalities: clone(info.inputModalities ?? listed.inputModalities),
      contextWindow: info.context?.contextWindow,
      defaultMaxTokens: info.defaultMaxTokens,
      reasoning: clone(info.reasoning),
    };
  } catch (error) {
    return {
      id: listed.id,
      name: listed.name ?? listed.id,
      inputModalities: clone(listed.inputModalities),
      resolutionError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function describeProvider(llm, descriptor, entry) {
  const provider = entry.provider;
  const valueProfile = profileAt(descriptor, 'value', provider) ?? {};
  const userProfile = profileAt(descriptor, 'user', provider) ?? {};
  const baseProfile = profileAt(descriptor, 'base', provider) ?? {};
  const configuredModels = Array.isArray(valueProfile.models) ? valueProfile.models : [];
  const userModels = Array.isArray(userProfile.models) ? userProfile.models : [];
  const userById = new Map(userModels.filter(isPlainObject).map((model) => [model.id, model]));
  const customModels = configuredModels.filter(isPlainObject).map((model) => ({
    id: typeof model.id === 'string' ? model.id : '',
    effective: publicModelFields(model),
    explicit: publicModelFields(userById.get(model.id)),
  }));
  const catalogMode = entry.declared === false && configuredModels.length === 0;
  let catalogModels = [];
  let catalogError = null;
  if (catalogMode && typeof llm.listModels === 'function') {
    try {
      const listed = await llm.listModels(provider);
      catalogModels = await Promise.all(listed.map((model) => resolvedModel(llm, provider, model)));
    } catch (error) {
      catalogError = error instanceof Error ? error.message : String(error);
    }
  }
  const userOverrides = isPlainObject(userProfile.modelOverrides) ? userProfile.modelOverrides : {};
  const baseOverrides = isPlainObject(baseProfile.modelOverrides) ? baseProfile.modelOverrides : {};
  catalogModels = catalogModels.map((model) => ({
    ...model,
    explicit: publicModelFields(userOverrides[model.id]),
    inheritedOverride: publicModelFields(baseOverrides[model.id]),
  }));
  return {
    provider,
    displayName: entry.displayName ?? provider,
    declared: entry.declared === true,
    configured: profileAt(descriptor, 'value', provider) !== undefined,
    catalogMode,
    customModels,
    catalogModels,
    catalogError,
  };
}

/**
 * Describe the llm-deepseek section's own catalog. Its models live at
 * `descriptor.user.models`, so nothing consults the pi-ai route shape.
 */
function describeDeepseekSection(descriptor, entry) {
  const valueModels = Array.isArray(descriptor.value?.models) ? descriptor.value.models : [];
  const userModels = Array.isArray(descriptor.user?.models) ? descriptor.user.models : [];
  const userById = new Map(userModels.filter(isPlainObject).map((model) => [model.id, model]));
  const customModels = valueModels.filter(isPlainObject).map((model) => ({
    id: typeof model.id === 'string' ? model.id : '',
    effective: publicDeepseekModelFields(model),
    explicit: publicDeepseekModelFields(userById.get(model.id)),
  }));
  return {
    provider: entry.provider,
    displayName: entry.displayName ?? entry.provider,
    declared: true,
    configured: true,
    catalogMode: false,
    customModels,
    catalogModels: [],
    catalogError: null,
  };
}

export function createModelCapabilitiesService(ctx) {
  return {
    async describe(provider) {
      const { settings, llm } = services(ctx);
      const descriptors = settingsDescriptors(settings);
      if (!descriptors.has(SETTINGS_NS) && !descriptors.has(DEEPSEEK_NS)) {
        throw new ModelCapabilitiesError(
          'This DSH version does not expose a model-catalog settings namespace.',
          409,
          'unsupported-dsh-version',
        );
      }
      const entries = directoryEntries(llm, descriptors);
      const directoryOnly = provider === null || provider === undefined || provider === '';
      const selected = directoryOnly
        ? entries
        : entries.filter((entry) => entry.provider === provider);
      if (provider && selected.length === 0) {
        throw new ModelCapabilitiesError(`Unknown model provider: ${provider}`, 404, 'unknown-provider');
      }
      const providerViews = [];
      for (const entry of selected) {
        const ns = entry.settingsNs;
        const descriptor = descriptors.get(ns);
        if (!descriptor) continue;
        const support = ns === DEEPSEEK_NS ? deepseekSupport(descriptor) : schemaSupport(descriptor);
        const base = {
          provider: entry.provider,
          displayName: entry.displayName ?? entry.provider,
          settingsNs: ns,
          kind: ns === DEEPSEEK_NS ? 'deepseek' : 'pi-ai',
          support,
        };
        if (!support.supported) {
          providerViews.push({
            ...base,
            declared: entry.declared === true,
            configured: ns === DEEPSEEK_NS
              ? true
              : profileAt(descriptor, 'value', entry.provider) !== undefined,
            catalogMode: ns === DEEPSEEK_NS ? false : entry.declared === false,
            customModels: [],
            catalogModels: [],
            catalogError: null,
          });
          continue;
        }
        // Directory reads carry the real model list too: the browser binds a
        // card to its provider by matching that list, so it must not be empty.
        providerViews.push({
          ...base,
          declared: entry.declared === true,
          ...(ns === DEEPSEEK_NS
            ? describeDeepseekSection(descriptor, entry)
            : await describeProvider(llm, descriptor, entry)),
        });
      }
      const primary = provider && providerViews.length > 0
        ? providerViews[0]
        : undefined;
      const primaryDescriptor = descriptors.get(primary?.settingsNs ?? SETTINGS_NS)
        ?? descriptors.get(DEEPSEEK_NS);
      const support = primary?.support ?? {
        supported: true, missing: [], fields: {}, compatFields: [], booleanCompatFields: [], objectCompatFields: [],
      };
      return {
        ok: true,
        namespace: primary?.settingsNs ?? SETTINGS_NS,
        revision: primaryDescriptor.revision,
        writable: settings.writable !== false,
        support,
        deepseek: {
          modalities: MODALITIES,
          capacityFields: DEEPSEEK_CAPACITY_FIELDS,
          imageFields: DEEPSEEK_IMAGE_FIELDS,
          defaults: DEEPSEEK_DEFAULTS,
        },
        options: {
          modalities: MODALITIES,
          thinkingLevels: THINKING_LEVELS,
          thinkingFormats: THINKING_FORMATS,
          maxTokensFields: MAX_TOKENS_FIELDS,
          cacheControlFormats: CACHE_CONTROL_FORMATS,
          chatTemplateVars: CHAT_TEMPLATE_VARS,
          booleanCompatFields: support.booleanCompatFields,
          enumCompatFields: ENUM_COMPAT_FIELDS,
          objectCompatFields: support.objectCompatFields,
        },
        providers: providerViews,
      };
    },

    async apply(payload) {
      if (!isPlainObject(payload)) throw new ModelCapabilitiesError('Request body must be an object.');
      const provider = assertIdentity(payload.provider, 'provider');
      if (!Array.isArray(payload.changes) || payload.changes.length === 0 || payload.changes.length > 200) {
        throw new ModelCapabilitiesError('changes must contain between 1 and 200 model updates.');
      }
      const { settings, llm } = services(ctx);
      const descriptors = settingsDescriptors(settings);
      const entry = directoryEntries(llm, descriptors).find((candidate) => candidate.provider === provider);
      if (!entry) throw new ModelCapabilitiesError(`Unknown model provider: ${provider}`, 404, 'unknown-provider');
      // The namespace comes from the directory entry, never from a guess: a
      // model row may only reach the document section it actually belongs to.
      const ns = entry.settingsNs;
      if (payload.settingsNs !== undefined && payload.settingsNs !== ns) {
        throw new ModelCapabilitiesError(
          `Model provider ${provider} belongs to the ${ns} settings namespace, not ${String(payload.settingsNs)}.`,
          409,
          'namespace-mismatch',
        );
      }
      const descriptor = descriptors.get(ns);
      if (!descriptor) {
        throw new ModelCapabilitiesError(`The ${ns} settings namespace is unavailable.`, 409, 'unsupported-dsh-version');
      }
      if (settings.writable === false) {
        throw new ModelCapabilitiesError('The DSH settings document is read-only.', 409, 'settings-read-only');
      }
      if (payload.expectedRevision !== undefined
        && (!Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 0)) {
        throw new ModelCapabilitiesError('expectedRevision must be a non-negative integer.');
      }
      if (ns === DEEPSEEK_NS) return applyDeepseek(settings, descriptor, provider, payload);

      const changes = payload.changes.map(validateChange);
      const duplicate = new Set();
      for (const change of changes) {
        const key = `${change.kind}:${change.modelId}`;
        if (duplicate.has(key)) throw new ModelCapabilitiesError(`Duplicate model change: ${change.modelId}`);
        duplicate.add(key);
      }
      const support = schemaSupport(descriptor);
      if (!support.supported) {
        throw new ModelCapabilitiesError(
          `This DSH version is missing model capability fields: ${support.missing.join(', ')}`,
          409,
          'unsupported-dsh-version',
        );
      }
      assertChangesSupported(changes, support);
      const initialSignature = providerSignature(descriptor, provider);
      let writeTarget = descriptor;
      let retried = false;
      while (true) {
        const ops = transactionFor(writeTarget, provider, changes);
        try {
          await settings.mutate(ns, ops, writeTarget.revision);
          const current = settingsDescriptor(settings, ns);
          return { ok: true, provider, settingsNs: ns, revision: current.revision, applied: changes.length, retried };
        } catch (error) {
          if (retried || !isConflict(error)) throw error;
          const latest = settingsDescriptor(settings, ns);
          if (providerSignature(latest, provider) !== initialSignature) {
            throw new ModelCapabilitiesError(
              'The model catalog changed while capabilities were being saved. Reopen the provider and try again.',
              409,
              'model-identity-changed',
            );
          }
          writeTarget = latest;
          retried = true;
        }
      }
    },
  };
}

/** Apply llm-deepseek catalog changes against that section's own `models` array. */
async function applyDeepseek(settings, descriptor, provider, payload) {
  const changes = payload.changes.map(validateDeepseekChange);
  const duplicate = new Set();
  for (const change of changes) {
    if (duplicate.has(change.modelId)) throw new ModelCapabilitiesError(`Duplicate model change: ${change.modelId}`);
    duplicate.add(change.modelId);
  }
  const support = deepseekSupport(descriptor);
  if (!support.supported) {
    throw new ModelCapabilitiesError(
      `This DSH version is missing llm-deepseek catalog fields: ${support.missing.join(', ')}`,
      409,
      'unsupported-dsh-version',
    );
  }
  const initialIds = deepseekModelIds(descriptor);
  let retried = false;
  while (true) {
    const ops = transactionForDeepseek(descriptor, changes);
    try {
      await settings.mutate(DEEPSEEK_NS, ops, descriptor.revision);
      const current = settingsDescriptor(settings, DEEPSEEK_NS);
      return { ok: true, provider, settingsNs: DEEPSEEK_NS, revision: current.revision, applied: changes.length, retried };
    } catch (error) {
      if (retried || !isConflict(error)) throw error;
      const latest = settingsDescriptor(settings, DEEPSEEK_NS);
      if (deepseekModelIds(latest) !== initialIds) {
        throw new ModelCapabilitiesError(
          'The model catalog changed while capabilities were being saved. Reopen the provider and try again.',
          409,
          'model-identity-changed',
        );
      }
      descriptor = latest;
      retried = true;
    }
  }
}

function deepseekModelIds(descriptor) {
  return JSON.stringify(deepseekWriteModels(descriptor).map((model) => (isPlainObject(model) ? model.id : null)));
}

export const MODEL_CAPABILITY_SCHEMA = Object.freeze({
  modalities: MODALITIES,
  thinkingLevels: THINKING_LEVELS,
  thinkingFormats: THINKING_FORMATS,
  maxTokensFields: MAX_TOKENS_FIELDS,
  cacheControlFormats: CACHE_CONTROL_FORMATS,
  chatTemplateVars: CHAT_TEMPLATE_VARS,
  booleanCompatFields: BOOLEAN_COMPAT_FIELDS,
  alphaBooleanCompatFields: ALPHA_BOOLEAN_COMPAT_FIELDS,
  enumCompatFields: ENUM_COMPAT_FIELDS,
  objectCompatFields: OBJECT_COMPAT_FIELDS,
});
