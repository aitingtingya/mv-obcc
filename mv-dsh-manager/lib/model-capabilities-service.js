// Model capability settings bridge for DSH's llm-pi-ai adapter.
//
// This module deliberately owns the complete settings/LLM contract. The
// manager entry point only delegates the two private HTTP routes to it, and no
// other manager feature needs to know how a model profile is represented.

const SETTINGS_NS = 'llm-pi-ai';
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
const ENUM_COMPAT_FIELDS = {
  thinkingFormat: THINKING_FORMATS,
  maxTokensField: MAX_TOKENS_FIELDS,
  cacheControlFormat: CACHE_CONTROL_FORMATS,
};
const COMPAT_FIELDS = [
  ...BOOLEAN_COMPAT_FIELDS,
  ...Object.keys(ENUM_COMPAT_FIELDS),
  'chatTemplateKwargs',
];
const MODEL_FIELDS = ['name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts'];
const BUILTIN_MODEL_FIELDS = new Set(MODEL_FIELDS);
const CUSTOM_MODEL_FIELDS = new Set(['input', 'reasoningEfforts']);
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

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

function schemaSupport(descriptor) {
  const serialized = JSON.stringify(descriptor?.schema ?? null);
  const has = (field) => serialized.includes(`"${field}"`);
  const required = ['models', 'modelOverrides', 'input', 'reasoningEfforts', 'compat', ...COMPAT_FIELDS];
  const missing = required.filter((field) => !has(field));
  return {
    supported: missing.length === 0,
    missing,
    fields: Object.fromEntries(required.map((field) => [field, has(field)])),
  };
}

function dynamicService(ctx, name) {
  // Cordis reflect proxies throw on undeclared service property reads (see
  // skills-service.js); `ctx.get()` is the official dynamic lookup, and
  // `ctx.reflect.get()` covers older access shapes. The bare property read is
  // the last resort for plain-object contexts and is guarded so a throwing
  // proxy still degrades to the unavailable branch instead of crashing.
  try {
    const service = ctx?.get?.(name);
    if (service != null) return service;
  } catch {
    // Fall through to reflection.
  }
  try {
    const service = ctx?.reflect?.get?.(name);
    if (service != null) return service;
  } catch {
    // Fall through to the guarded property read.
  }
  try {
    return ctx?.[name];
  } catch {
    return undefined;
  }
}

function services(ctx) {
  const settings = dynamicService(ctx, 'settings');
  const llm = dynamicService(ctx, 'llm');
  if (!settings || typeof settings.describe !== 'function' || typeof settings.mutate !== 'function') {
    throw new ModelCapabilitiesError('DSH settings service is unavailable.', 503, 'settings-unavailable');
  }
  if (!llm) throw new ModelCapabilitiesError('DSH LLM service is unavailable.', 503, 'llm-unavailable');
  return { settings, llm };
}

function settingsDescriptor(settings) {
  const descriptor = settings.describe({ redactSecrets: true })
    .find((entry) => entry?.ns === SETTINGS_NS);
  if (!descriptor) {
    throw new ModelCapabilitiesError(
      'This DSH version does not expose the llm-pi-ai settings namespace.',
      409,
      'unsupported-dsh-version',
    );
  }
  return descriptor;
}

function directoryEntries(llm, descriptor) {
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
    if (BOOLEAN_COMPAT_FIELDS.includes(field)) {
      if (typeof entry !== 'boolean') throw new ModelCapabilitiesError(`${field} must be true or false.`);
      result[field] = entry;
      continue;
    }
    if (field === 'chatTemplateKwargs') {
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
  const valueProfile = profileAt(descriptor, 'value', provider) ?? {};
  const userProfile = profileAt(descriptor, 'user', provider) ?? {};
  const customChanges = changes.filter((change) => change.kind === 'custom');
  const builtinChanges = changes.filter((change) => change.kind === 'builtin');
  if (customChanges.length > 0 && builtinChanges.length > 0) {
    throw new ModelCapabilitiesError('Custom models and built-in overrides cannot be changed in one provider profile.');
  }
  if (customChanges.length > 0) {
    const source = Array.isArray(userProfile.models)
      ? userProfile.models
      : Array.isArray(valueProfile.models) ? valueProfile.models : [];
    const models = clone(source);
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

export function createModelCapabilitiesService(ctx) {
  return {
    async describe(provider) {
      const { settings, llm } = services(ctx);
      const descriptor = settingsDescriptor(settings);
      const support = schemaSupport(descriptor);
      const entries = directoryEntries(llm, descriptor);
      const directoryOnly = provider === null || provider === undefined || provider === '';
      const selected = directoryOnly
        ? entries
        : entries.filter((entry) => entry.provider === provider);
      if (provider && selected.length === 0) {
        throw new ModelCapabilitiesError(`Unknown llm-pi-ai provider: ${provider}`, 404, 'unknown-provider');
      }
      const providers = support.supported && !directoryOnly
        ? await Promise.all(selected.map((entry) => describeProvider(llm, descriptor, entry)))
        : selected.map((entry) => ({
          provider: entry.provider,
          displayName: entry.displayName ?? entry.provider,
          declared: entry.declared === true,
          configured: profileAt(descriptor, 'value', entry.provider) !== undefined,
          catalogMode: entry.declared === false,
          customModels: [],
          catalogModels: [],
          catalogError: null,
        }));
      return {
        ok: true,
        namespace: SETTINGS_NS,
        revision: descriptor.revision,
        writable: settings.writable !== false,
        support,
        options: {
          modalities: MODALITIES,
          thinkingLevels: THINKING_LEVELS,
          thinkingFormats: THINKING_FORMATS,
          maxTokensFields: MAX_TOKENS_FIELDS,
          cacheControlFormats: CACHE_CONTROL_FORMATS,
          chatTemplateVars: CHAT_TEMPLATE_VARS,
          booleanCompatFields: BOOLEAN_COMPAT_FIELDS,
          enumCompatFields: ENUM_COMPAT_FIELDS,
        },
        providers,
      };
    },

    async apply(payload) {
      if (!isPlainObject(payload)) throw new ModelCapabilitiesError('Request body must be an object.');
      const provider = assertIdentity(payload.provider, 'provider');
      if (!Array.isArray(payload.changes) || payload.changes.length === 0 || payload.changes.length > 200) {
        throw new ModelCapabilitiesError('changes must contain between 1 and 200 model updates.');
      }
      const changes = payload.changes.map(validateChange);
      const duplicate = new Set();
      for (const change of changes) {
        const key = `${change.kind}:${change.modelId}`;
        if (duplicate.has(key)) throw new ModelCapabilitiesError(`Duplicate model change: ${change.modelId}`);
        duplicate.add(key);
      }
      const { settings, llm } = services(ctx);
      let descriptor = settingsDescriptor(settings);
      const support = schemaSupport(descriptor);
      if (!support.supported) {
        throw new ModelCapabilitiesError(
          `This DSH version is missing model capability fields: ${support.missing.join(', ')}`,
          409,
          'unsupported-dsh-version',
        );
      }
      const known = directoryEntries(llm, descriptor).some((entry) => entry.provider === provider);
      if (!known) throw new ModelCapabilitiesError(`Unknown llm-pi-ai provider: ${provider}`, 404, 'unknown-provider');
      if (settings.writable === false) {
        throw new ModelCapabilitiesError('The DSH settings document is read-only.', 409, 'settings-read-only');
      }
      if (payload.expectedRevision !== undefined
        && (!Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 0)) {
        throw new ModelCapabilitiesError('expectedRevision must be a non-negative integer.');
      }
      const initialSignature = providerSignature(descriptor, provider);
      let retried = false;
      while (true) {
        const ops = transactionFor(descriptor, provider, changes);
        try {
          await settings.mutate(SETTINGS_NS, ops, descriptor.revision);
          const current = settingsDescriptor(settings);
          return { ok: true, provider, revision: current.revision, applied: changes.length, retried };
        } catch (error) {
          if (retried || !isConflict(error)) throw error;
          const latest = settingsDescriptor(settings);
          if (providerSignature(latest, provider) !== initialSignature) {
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
    },
  };
}

export const MODEL_CAPABILITY_SCHEMA = Object.freeze({
  modalities: MODALITIES,
  thinkingLevels: THINKING_LEVELS,
  thinkingFormats: THINKING_FORMATS,
  maxTokensFields: MAX_TOKENS_FIELDS,
  cacheControlFormats: CACHE_CONTROL_FORMATS,
  chatTemplateVars: CHAT_TEMPLATE_VARS,
  booleanCompatFields: BOOLEAN_COMPAT_FIELDS,
  enumCompatFields: ENUM_COMPAT_FIELDS,
});
