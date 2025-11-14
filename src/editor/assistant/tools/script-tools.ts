import type { Observer } from '@playcanvas/observer';

import {
    DEFAULT_SCRIPT_USAGE_LIMIT,
    MAX_SCRIPT_ATTRIBUTE_REMOVALS,
    MAX_SCRIPT_ATTRIBUTE_UPDATES,
    MAX_SCRIPT_CONFIGS,
    clampNumber,
    normalizeEntityId,
    buildEntitySummary,
    buildAssetSummary,
    buildScriptUsageEntitySummary,
    resolveScriptNames,
    formatError,
    cloneWritableValue,
    applyObserverRemovals
} from './tool-common.ts';
import type { AssistantToolDefinition } from '../../../common/ai/assistant-client.ts';

type ScriptReadArgs = {
    assetId: number;
};

type ScriptWriteArgs = {
    assetId?: number | null;
    folderId?: number | null;
    filename?: string | null;
    contents: string;
    description?: string | null;
};

type ScriptAttributeUpdate = {
    path: string;
    value?: string | number | boolean | null;
    jsonValue?: string | null;
};

type ScriptConfigInput = {
    name: string;
    action?: 'add' | 'update' | 'remove' | 'delete' | null;
    enabled?: boolean | null;
    attributes?: ScriptAttributeUpdate[] | null;
    attributeRemovals?: string[] | null;
    orderIndex?: number | null;
};

type ScriptUsageArgs = {
    scriptName?: string | null;
    assetId?: number | null;
    includeAttributes?: boolean | null;
    includeComponents?: boolean | null;
    maxEntities?: number | null;
};

const getScriptAsset = (assetId: number) => {
    const asset = editor.call('assets:get', assetId) as Observer | null;
    if (!asset) {
        throw new Error(`No asset found with id ${assetId}.`);
    }
    if (asset.get('type') !== 'script') {
        throw new Error(`Asset ${assetId} is not a script (type is "${asset.get('type')}").`);
    }
    return asset;
};

const fetchScriptContents = (asset: Observer) => {
    return new Promise<string>((resolve, reject) => {
        const file = asset.get('file');
        const filename = file?.filename;
        if (!filename) {
            reject(new Error(`Script asset ${asset.get('id')} does not have a file.`));
            return;
        }

        editor.api.globals.rest.assets.assetGetFile(asset.get('id'), filename, { branchId: config.self.branch.id })
        .on('load', (_status: number, data: string) => {
            resolve((data || '').replace(/\r\n?/g, '\n'));
        })
        .on('error', (status: number, err: string) => {
            reject(new Error(err || `Failed to load script asset ${asset.get('id')} (status ${status}).`));
        });
    });
};

const scriptMimeFromFilename = (filename: string) => {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.mjs') || lower.endsWith('.js')) {
        return 'text/javascript';
    }
    return 'text/plain';
};

const SCRIPT_FILE_READY_TIMEOUT_MS = 10_000;
const SCRIPT_PARSE_TIMEOUT_MS = 15_000;

type ScriptParseStatus = 'ok' | 'invalid' | 'timeout' | 'error' | 'skipped';
type ScriptParseSummary = {
    status: ScriptParseStatus;
    errors?: string[];
    warnings?: string[];
};

type ScriptParsePayload = {
    scriptsInvalid?: unknown[];
    scripts?: Record<string, { attributesInvalid?: unknown[] }>;
};

const isScriptParsingEnabled = () => {
    try {
        const settings = editor.call('settings:project') as { get?: (key: string) => unknown } | null;
        if (settings && typeof settings.get === 'function') {
            return !settings.get('useLegacyScripts');
        }
    } catch (error) {
        console.warn('[Assistant] Failed to inspect project settings for script parsing', error);
    }
    return true;
};

const waitForAssetFileReady = (asset: Observer, timeoutMs = SCRIPT_FILE_READY_TIMEOUT_MS) => {
    const file = asset.get('file');
    if (file?.url) {
        return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
        let settled = false;
        let timerId: number | undefined;
        const handleComplete = (callback: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timerId !== undefined) {
                window.clearTimeout(timerId);
            }
            asset.off('file.url:set', onFileUrlSet);
            callback();
        };

        const onFileUrlSet = () => {
            handleComplete(() => resolve());
        };

        timerId = window.setTimeout(() => {
            handleComplete(() => {
                reject(new Error('Timed out while waiting for the script file to become available.'));
            });
        }, timeoutMs);

        asset.on('file.url:set', onFileUrlSet);
    });
};

const describeScriptInvalidEntry = (entry: unknown, fallbackFile: string) => {
    if (!entry) {
        return 'Unknown script parsing error.';
    }
    if (typeof entry === 'string') {
        return entry;
    }
    if (typeof entry === 'object') {
        const details = entry as { message?: unknown; file?: unknown; line?: unknown; column?: unknown };
        const file = typeof details.file === 'string' && details.file.trim().length ? details.file.trim() : fallbackFile;
        const line = typeof details.line === 'number' ? details.line : null;
        const column = typeof details.column === 'number' ? details.column : null;
        const locationParts: string[] = [];
        if (file) {
            locationParts.push(file);
        }
        if (line !== null) {
            locationParts.push(String(line));
        }
        if (column !== null) {
            locationParts.push(String(column));
        }
        const location = locationParts.join(':');
        const message = typeof details.message === 'string' && details.message.trim().length
            ? details.message.trim()
            : 'Script parsing error.';
        return location ? `${location} - ${message}` : message;
    }
    return String(entry);
};

const describeAttributeIssue = (scriptName: string, issue: unknown) => {
    if (!issue) {
        return null;
    }
    if (typeof issue === 'string') {
        return {
            message: `${scriptName}: ${issue}`,
            severity: null as number | null
        };
    }
    if (typeof issue !== 'object') {
        return {
            message: `${scriptName}: ${String(issue)}`,
            severity: null as number | null
        };
    }

    const details = issue as {
        severity?: unknown;
        message?: unknown;
        fileName?: unknown;
        startLineNumber?: unknown;
        startColumn?: unknown;
        name?: unknown;
    };

    const locationParts: string[] = [];
    if (typeof details.fileName === 'string' && details.fileName.trim().length) {
        locationParts.push(details.fileName.trim());
    }
    if (typeof details.startLineNumber === 'number') {
        let lineSegment = String(details.startLineNumber);
        if (typeof details.startColumn === 'number') {
            lineSegment += `:${details.startColumn}`;
        }
        locationParts.push(lineSegment);
    }
    const location = locationParts.join(':') || scriptName;
    const name = typeof details.name === 'string' && details.name.trim().length ? ` (${details.name.trim()})` : '';
    const message = typeof details.message === 'string' && details.message.trim().length
        ? details.message.trim()
        : 'Attribute validation issue.';

    return {
        message: `${location}${name} - ${message}`,
        severity: typeof details.severity === 'number' ? details.severity : null
    };
};

const summarizeScriptParseResult = (result: ScriptParsePayload | undefined, fallbackFile: string) => {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (Array.isArray(result?.scriptsInvalid)) {
        for (const entry of result.scriptsInvalid) {
            errors.push(describeScriptInvalidEntry(entry, fallbackFile));
        }
    }

    if (result?.scripts && typeof result.scripts === 'object') {
        for (const [scriptName, scriptDetails] of Object.entries(result.scripts)) {
            const invalidAttributes = Array.isArray(scriptDetails?.attributesInvalid) ? scriptDetails.attributesInvalid : [];
            for (const issue of invalidAttributes) {
                const described = describeAttributeIssue(scriptName, issue);
                if (!described) {
                    continue;
                }
                if (described.severity === 4) {
                    warnings.push(described.message);
                } else {
                    errors.push(described.message);
                }
            }
        }
    }

    return { errors, warnings };
};

const runScriptParseCheck = async (asset: Observer): Promise<ScriptParseSummary | null> => {
    if (!isScriptParsingEnabled()) {
        return { status: 'skipped' };
    }

    try {
        await waitForAssetFileReady(asset);
    } catch (error) {
        return {
            status: 'error',
            errors: [`Unable to read script file: ${formatError(error)}`]
        };
    }

    return new Promise<ScriptParseSummary>((resolve) => {
        let settled = false;
        let timerId: number | undefined;
        const finish = (summary: ScriptParseSummary) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timerId !== undefined) {
                window.clearTimeout(timerId);
            }
            resolve(summary);
        };

        timerId = window.setTimeout(() => {
            finish({
                status: 'timeout',
                errors: ['Script parsing timed out. This usually indicates malformed code.']
            });
        }, SCRIPT_PARSE_TIMEOUT_MS);

        try {
            editor.call('scripts:parse', asset, (error: unknown, result?: ScriptParsePayload) => {
                if (error) {
                    finish({
                        status: 'error',
                        errors: [`Script parsing failed: ${formatError(error)}`]
                    });
                    return;
                }
                const assetName = asset.get('name') || asset.get('file')?.filename || 'script';
                const summary = summarizeScriptParseResult(result, assetName);
                if (summary.errors.length) {
                    finish({
                        status: 'invalid',
                        errors: summary.errors,
                        warnings: summary.warnings.length ? summary.warnings : undefined
                    });
                    return;
                }
                finish({
                    status: 'ok',
                    warnings: summary.warnings.length ? summary.warnings : undefined
                });
            });
        } catch (error) {
            const message = formatError(error);
            if (message.includes('scripts:parse')) {
                finish({ status: 'skipped' });
                return;
            }
            finish({
                status: 'error',
                errors: [`Script parsing call failed: ${message}`]
            });
        }
    });
};

const DEFAULT_SCRIPT_FOLDER_NAME = 'scripts';

const normalizeFolderName = (value: unknown) => {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
};

const findDefaultScriptsFolder = () => {
    const assets = editor.call('assets:list') as Observer[] | null;
    if (!Array.isArray(assets)) {
        return null;
    }

    let chosen: Observer | null = null;
    let bestDepth = Number.POSITIVE_INFINITY;

    for (const asset of assets) {
        if (!asset || asset.get('type') !== 'folder') {
            continue;
        }
        const assetId = asset.get('id');
        if (typeof assetId !== 'number' || Number.isNaN(assetId)) {
            continue;
        }
        if (normalizeFolderName(asset.get('name')) !== DEFAULT_SCRIPT_FOLDER_NAME) {
            continue;
        }

        const path = asset.get('path');
        const depth = Array.isArray(path) ? path.length : 0;
        if (!chosen || depth < bestDepth) {
            chosen = asset;
            bestDepth = depth;
        }
    }

    return chosen;
};

const resolveFolderFromId = (folderId?: number | null) => {
    if (typeof folderId === 'number' && !Number.isNaN(folderId)) {
        const folder = editor.call('assets:get', folderId) as Observer | null;
        if (!folder) {
            throw new Error(`No folder found with id ${folderId}.`);
        }
        if (folder.get('type') !== 'folder') {
            throw new Error(`Asset ${folderId} is not a folder.`);
        }
        return folder;
    }
    const selected = editor.call('assets:selected:folder') as Observer | null;
    if (selected) {
        return selected;
    }
    return findDefaultScriptsFolder();
};

const updateScriptAsset = async (asset: Observer, contents: string, overrideFilename?: string | null) => {
    const currentFilename = asset.get('file')?.filename;
    const filename = (overrideFilename && overrideFilename.trim()) || currentFilename || `${asset.get('name') || 'script'}.mjs`;
    const blob = new Blob([contents], { type: scriptMimeFromFilename(filename) });

    const updated = await editor.api.globals.assets.upload({
        id: asset.get('id'),
        type: 'script',
        filename,
        file: blob
    });

    return (updated as { observer?: Observer } | null)?.observer || asset;
};

const createScriptAsset = async (filename: string, contents: string, folder: Observer | null) => {
    const sanitizedFilename = filename.trim();
    const payload: Record<string, unknown> = {
        name: sanitizedFilename,
        type: 'script',
        filename: sanitizedFilename,
        preload: true,
        file: new Blob([contents], { type: scriptMimeFromFilename(sanitizedFilename) }),
        data: {
            scripts: {},
            loading: false,
            loadingType: 0
        }
    };

    if (folder) {
        (payload as { folder: Observer }).folder = folder;
    }

    const asset = await editor.api.globals.assets.upload(payload);
    return asset as Observer | null;
};

const adjustScriptOrder = (entity: Observer, scriptName: string, rawIndex?: number | null) => {
    if (typeof rawIndex !== 'number' || Number.isNaN(rawIndex)) {
        return null;
    }

    const sanitizedIndex = Math.max(0, Math.floor(rawIndex));
    const order = entity.get('components.script.order');
    const orderList = Array.isArray(order) ? [...order] : [];
    const currentIndex = orderList.indexOf(scriptName);
    const limit = currentIndex !== -1 ? Math.max(orderList.length - 1, 0) : orderList.length;
    const clampedIndex = Math.min(sanitizedIndex, limit);

    if (currentIndex === clampedIndex && currentIndex !== -1) {
        return null;
    }

    const historyState = typeof entity.history?.enabled === 'boolean' ? entity.history.enabled : null;
    try {
        if (historyState !== null) {
            entity.history.enabled = false;
        }
        if (currentIndex !== -1) {
            entity.removeValue('components.script.order', scriptName);
        }
        entity.insert('components.script.order', scriptName, clampedIndex);
    } finally {
        if (historyState !== null) {
            entity.history.enabled = historyState;
        }
    }

    return {
        previousIndex: currentIndex,
        newIndex: clampedIndex
    };
};

const configureScriptInstance = async (entity: Observer, config: ScriptConfigInput) => {
    const scriptName = typeof config.name === 'string' ? config.name.trim() : '';
    if (!scriptName) {
        throw new Error('Each script entry requires a non-empty name.');
    }

    if (config.attributes !== undefined && config.attributes !== null && !Array.isArray(config.attributes)) {
        throw new Error(`attributes for script "${scriptName}" must be provided as an array.`);
    }

    if (config.attributeRemovals !== undefined && config.attributeRemovals !== null && !Array.isArray(config.attributeRemovals)) {
        throw new Error(`attributeRemovals for script "${scriptName}" must be an array of strings.`);
    }

    if (config.orderIndex !== undefined && config.orderIndex !== null && typeof config.orderIndex !== 'number') {
        throw new Error(`orderIndex for script "${scriptName}" must be a number.`);
    }

    const normalizedAction = typeof config.action === 'string' ? config.action.toLowerCase() : null;
    const removeRequested = normalizedAction === 'remove' || normalizedAction === 'delete';
    const scriptPath = `components.script.scripts.${scriptName}`;
    const scriptExists = !!entity.get(scriptPath);
    const apiEntity = entity.apiEntity;

    if (!apiEntity) {
        throw new Error('Entity API bridge is unavailable.');
    }

    if (removeRequested) {
        if (!scriptExists) {
            return {
                scriptName,
                status: 'skipped',
                note: 'Script is not present on the entity.'
            };
        }

        await editor.api.globals.entities.removeScript([apiEntity], scriptName);
        return {
            scriptName,
            status: 'removed'
        };
    }

    const asset = editor.call('assets:scripts:assetByScript', scriptName) as Observer | null;
    if (!asset) {
        throw new Error(`Script "${scriptName}" is not defined in any preloaded script asset.`);
    }

    if (!scriptExists) {
        await editor.api.globals.entities.addScript([apiEntity], scriptName);
    }

    const updatedFields: string[] = [];
    const removedFields: string[] = [];

    if (typeof config.enabled === 'boolean') {
        entity.set(`${scriptPath}.enabled`, config.enabled);
        updatedFields.push(`${scriptPath}.enabled`);
    }

    if (Array.isArray(config.attributes) && config.attributes.length) {
        const limitedUpdates = config.attributes.slice(0, MAX_SCRIPT_ATTRIBUTE_UPDATES);
        for (const update of limitedUpdates) {
            if (!update || typeof update !== 'object') {
                throw new Error(`Invalid attribute entry supplied for script "${scriptName}".`);
            }

            const path = typeof update.path === 'string' ? update.path.trim() : '';
            if (!path) {
                throw new Error(`Attribute entries for script "${scriptName}" must include a non-empty "path".`);
            }

            let value: unknown = Object.prototype.hasOwnProperty.call(update, 'value') ? update.value ?? null : null;
            const rawJson = typeof update.jsonValue === 'string' ? update.jsonValue.trim() : '';
            if (rawJson.length) {
                try {
                    value = JSON.parse(rawJson);
                } catch (error) {
                    throw new Error(`jsonValue for attribute "${path}" on script "${scriptName}" is not valid JSON: ${formatError(error)}`);
                }
            }

            entity.set(`${scriptPath}.attributes.${path}`, cloneWritableValue(value));
            updatedFields.push(`${scriptPath}.attributes.${path}`);
        }

        if (config.attributes.length > limitedUpdates.length) {
            updatedFields.push('[truncatedAttributeUpdates]');
        }
    }

    if (Array.isArray(config.attributeRemovals)) {
        applyObserverRemovals(
            entity,
            `${scriptPath}.attributes`,
            config.attributeRemovals,
            removedFields,
            MAX_SCRIPT_ATTRIBUTE_REMOVALS
        );
    }

    const orderChange = adjustScriptOrder(entity, scriptName, config.orderIndex);

    return {
        scriptName,
        status: scriptExists ? 'updated' : 'added',
        updatedFields: updatedFields.length ? updatedFields : undefined,
        removedFields: removedFields.length ? removedFields : undefined,
        orderChange: orderChange || undefined
    };
};

const describeScriptUsageTool: AssistantToolDefinition<ScriptUsageArgs> = {
    name: 'describe_script_usage',
    description: 'Shows which entities use a given script, including optional attribute payloads, so the model can understand gameplay wiring.',
    parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['scriptName', 'assetId', 'includeAttributes', 'includeComponents', 'maxEntities'],
        properties: {
            scriptName: {
                type: ['string', 'null'],
                description: 'Name of the script (e.g. returned by describe_entity_components).'
            },
            assetId: {
                type: ['number', 'null'],
                description: 'Optional script asset id to enumerate all contained scripts.'
            },
            includeAttributes: {
                type: ['boolean', 'null'],
                description: 'Include sanitized script attributes for each entity (defaults to false).'
            },
            includeComponents: {
                type: ['boolean', 'null'],
                description: 'Include component summaries for each entity.'
            },
            maxEntities: {
                type: ['number', 'null'],
                description: 'Maximum number of entities per script (default 10, max 20).'
            }
        }
    },
    handler: (rawArgs) => {
        if (!rawArgs) {
            return {
                error: 'Provide scriptName or assetId to inspect usage.'
            };
        }

        const scriptNames = resolveScriptNames(rawArgs);
        if (!scriptNames.length) {
            return {
                error: 'No script names could be resolved. Provide scriptName or a script asset containing scripts.'
            };
        }

        const includeAttributes = typeof rawArgs.includeAttributes === 'boolean' ? rawArgs.includeAttributes : false;
        const includeComponents = typeof rawArgs.includeComponents === 'boolean' ? rawArgs.includeComponents : false;
        const maxEntities = clampNumber(rawArgs.maxEntities, DEFAULT_SCRIPT_USAGE_LIMIT);
        const summaries: Record<string, unknown>[] = [];

        for (const scriptName of scriptNames) {
            const asset = editor.call('assets:scripts:assetByScript', scriptName) as Observer | null;
            const collisions = editor.call('assets:scripts:collide', scriptName) as Record<string, Observer> | null | undefined;
            const entities = (editor.call('entities:list:byScript', scriptName) || []) as Observer[];
            const entitySummaries: Record<string, unknown>[] = [];
            let overflow = 0;

            for (const entity of entities) {
                if (entitySummaries.length < maxEntities) {
                    entitySummaries.push(buildScriptUsageEntitySummary(entity, scriptName, includeComponents, includeAttributes));
                } else {
                    overflow++;
                }
            }

            const summary: Record<string, unknown> = {
                scriptName,
                entityCount: entities.length,
                entities: entitySummaries
            };

            if (asset) {
                summary.asset = buildAssetSummary(asset);
            } else {
                summary.warnings = ['Script has no matching asset. It may not be preloaded.'];
            }

            if (collisions && Object.keys(collisions).length) {
                summary.assetCollisions = Object.keys(collisions).map((key) => {
                    const numeric = Number(key);
                    return Number.isNaN(numeric) ? key : numeric;
                });
            }

            if (overflow > 0) {
                summary.moreEntities = overflow;
            } else if (!entities.length) {
                summary.note = 'No entities currently use this script.';
            }

            summaries.push(summary);
        }

        return {
            scripts: summaries
        };
    }
};

const readScriptTool: AssistantToolDefinition<ScriptReadArgs> = {
    name: 'read_script_asset',
    description: 'Loads the current contents of a script asset so the assistant can reason about the existing code.',
    parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['assetId'],
        properties: {
            assetId: {
                type: 'number',
                description: 'ID of the script asset to read.'
            }
        }
    },
    handler: async (rawArgs) => {
        const assetId = typeof rawArgs?.assetId === 'number' ? rawArgs.assetId : null;
        if (assetId === null) {
            return {
                error: 'assetId is required.'
            };
        }

        try {
            const asset = getScriptAsset(assetId);
            const content = await fetchScriptContents(asset);
            return {
                asset: buildAssetSummary(asset),
                length: content.length,
                content
            };
        } catch (error) {
            return {
                error: formatError(error)
            };
        }
    }
};

const buildScriptWriteResponse = (
    action: 'created' | 'updated',
    asset: Observer,
    characters: number,
    description: string | null,
    parseSummary?: ScriptParseSummary | null
) => {
    const response: Record<string, unknown> = {
        action,
        asset: buildAssetSummary(asset),
        characters,
        note: description,
        parseStatus: parseSummary?.status ?? 'ok'
    };

    if (!parseSummary || parseSummary.status === 'skipped' || parseSummary.status === 'ok') {
        if (parseSummary?.warnings?.length) {
            response.parseWarnings = parseSummary.warnings;
        }
        return response;
    }

    if (parseSummary.errors?.length) {
        response.parseErrors = parseSummary.errors;
    }
    if (parseSummary.warnings?.length) {
        response.parseWarnings = parseSummary.warnings;
    }

    let errorMessage = 'Script parsing failed. Review parseErrors for details.';
    if (parseSummary.status === 'timeout') {
        errorMessage = 'Script parsing timed out. The script likely contains syntax errors.';
    } else if (parseSummary.status === 'invalid') {
        errorMessage = 'Script parsing reported errors. Fix the code and try again.';
    } else if (parseSummary.status === 'error') {
        errorMessage = parseSummary.errors?.[0] || errorMessage;
    }

    response.error = errorMessage;
    return response;
};

const writeScriptTool: AssistantToolDefinition<ScriptWriteArgs> = {
    name: 'write_script_asset',
    description: 'Creates a new script asset or overwrites an existing one with the provided contents. All scripts must be authored as PlayCanvas ESM modules: use the `.mjs` extension, import { Script } from \'playcanvas\', export one or more classes that extend Script, and set static scriptName on every exported class. Avoid legacy pc.createScript patterns—always rely on ES module syntax (imports/exports) so multiple classes can be exported from a single file when needed.',
    strict: false,
    parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['contents'],
        properties: {
            assetId: {
                type: ['number', 'null'],
                description: 'Existing script asset id to overwrite. Leave null to create a new asset.'
            },
            folderId: {
                type: ['number', 'null'],
                description: 'Target folder id for new scripts. Defaults to the currently selected folder.'
            },
            filename: {
                type: ['string', 'null'],
                description: 'Filename for new scripts or to override the existing filename.'
            },
            contents: {
                type: 'string',
                description: 'Full script text that will be written to the asset.'
            },
            description: {
                type: ['string', 'null'],
                description: 'Optional human-readable summary of the change for logging or UI use.'
            }
        }
    },
    handler: async (rawArgs) => {
        if (!editor.call('permissions:write')) {
            return {
                error: 'Write permission is required to modify script assets.'
            };
        }

        if (!rawArgs || typeof rawArgs.contents !== 'string') {
            return {
                error: 'contents must be provided as a string.'
            };
        }

        const normalizedContents = rawArgs.contents.replace(/\r\n?/g, '\n');
        const filename = typeof rawArgs.filename === 'string' && rawArgs.filename.trim().length ? rawArgs.filename.trim() : null;
        const assetId = typeof rawArgs.assetId === 'number' ? rawArgs.assetId : null;
        const description = typeof rawArgs.description === 'string' && rawArgs.description.trim().length ? rawArgs.description.trim() : null;

        try {
            if (assetId !== null) {
                const asset = getScriptAsset(assetId);
                const updatedAsset = await updateScriptAsset(asset, normalizedContents, filename);
                const parseSummary = await runScriptParseCheck(updatedAsset);
                return buildScriptWriteResponse('updated', updatedAsset, normalizedContents.length, description, parseSummary);
            }

            if (!filename) {
                return {
                    error: 'filename is required when creating a new script.'
                };
            }

            const folder = resolveFolderFromId(typeof rawArgs.folderId === 'number' ? rawArgs.folderId : null);
            const newAsset = await createScriptAsset(filename, normalizedContents, folder);
            if (!newAsset) {
                throw new Error('The new script asset could not be resolved after creation.');
            }

            const parseSummary = await runScriptParseCheck(newAsset);
            return buildScriptWriteResponse('created', newAsset, normalizedContents.length, description, parseSummary);
        } catch (error) {
            return {
                error: formatError(error)
            };
        }
    }
};

const configureEntityScriptsTool: AssistantToolDefinition<{ entityId: number | string; scripts: ScriptConfigInput[] }> = {
    name: 'configure_entity_scripts',
    description: 'Adds, updates, reorders, or removes script instances on an entity, including attribute values and enabled state.',
    parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['entityId', 'scripts'],
        properties: {
            entityId: {
                type: ['number', 'string'],
                description: 'resource_id or GUID of the target entity.'
            },
            scripts: {
                type: 'array',
                minItems: 1,
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['name', 'action', 'enabled', 'attributes', 'attributeRemovals', 'orderIndex'],
                    properties: {
                        name: {
                            type: 'string',
                            description: 'Name of the script object (e.g. returned by describe_entity_components).'
                        },
                        action: {
                            type: ['string', 'null'],
                            enum: ['add', 'update', 'remove', 'delete', null],
                            description: 'Optional explicit action. Defaults to add/update.'
                        },
                        enabled: {
                            type: ['boolean', 'null'],
                            description: 'Enable or disable the script instance.'
                        },
                        attributes: {
                            type: ['array', 'null'],
                            description: 'List of attribute updates (each entry targets a dot-separated path under the script attributes object).',
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                required: ['path', 'value', 'jsonValue'],
                                properties: {
                                    path: {
                                        type: 'string',
                                        description: 'Attribute name or dot path relative to the script attributes object (e.g. "speed" or "stats.maxHealth").'
                                    },
                                    value: {
                                        type: ['string', 'number', 'boolean', 'null'],
                                        description: 'Primitive value to assign. Ignored when jsonValue is provided.'
                                    },
                                    jsonValue: {
                                        type: ['string', 'null'],
                                        description: 'Optional JSON string used for complex arrays/objects. When provided, this overrides the primitive value.'
                                    }
                                }
                            }
                        },
                        attributeRemovals: {
                            type: ['array', 'null'],
                            description: 'Attribute keys to remove (relative to the script attributes object).',
                            items: {
                                type: 'string'
                            }
                        },
                        orderIndex: {
                            type: ['number', 'null'],
                            description: 'Optional target order index for the script.'
                        }
                    }
                },
                description: 'List of script operations to perform (processed up to 10 entries).'
            }
        }
    },
    handler: async (rawArgs) => {
        if (!editor.call('permissions:write')) {
            return {
                error: 'Write permission is required to modify entity scripts.'
            };
        }

        const entityId = normalizeEntityId(rawArgs?.entityId);
        if (entityId === null) {
            return {
                error: 'entityId is required.'
            };
        }

        const entity = editor.call('entities:get', entityId) as Observer | null;
        if (!entity) {
            return {
                error: `No entity found with id ${entityId}.`
            };
        }

        const scriptEntries = Array.isArray(rawArgs?.scripts) ? rawArgs.scripts : null;
        if (!scriptEntries || !scriptEntries.length) {
            return {
                error: 'scripts must be a non-empty array.'
            };
        }

        const limitedEntries = scriptEntries.slice(0, MAX_SCRIPT_CONFIGS);
        const truncated = scriptEntries.length > limitedEntries.length;
        const results: Record<string, unknown>[] = [];

        for (const entry of limitedEntries) {
            if (!entry || typeof entry !== 'object') {
                results.push({
                    scriptName: null,
                    status: 'error',
                    error: 'Each script entry must be an object.'
                });
                continue;
            }

            const scriptName = typeof entry.name === 'string' ? entry.name.trim() : '';
            if (!scriptName) {
                results.push({
                    scriptName: null,
                    status: 'error',
                    error: 'Each script entry requires a non-empty "name".'
                });
                continue;
            }

            try {
                // Sequential execution ensures deterministic ordering of add/update/remove calls.
                // eslint-disable-next-line no-await-in-loop
                const result = await configureScriptInstance(entity, {
                    ...entry,
                    name: scriptName
                });
                results.push(result);
            } catch (error) {
                results.push({
                    scriptName,
                    status: 'error',
                    error: formatError(error)
                });
            }
        }

        return {
            entity: buildEntitySummary(entity, true),
            processedScripts: results.length,
            truncated: truncated || undefined,
            results
        };
    }
};

export const createScriptTools = (): AssistantToolDefinition[] => [
    describeScriptUsageTool,
    readScriptTool,
    writeScriptTool,
    configureEntityScriptsTool
];
