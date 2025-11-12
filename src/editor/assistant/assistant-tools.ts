import type { Observer } from '@playcanvas/observer';

import type { AssistantToolDefinition } from '../../common/ai/assistant-client.ts';

type SelectionToolArgs = {
    maxItems?: number;
    includeComponents?: boolean;
};

type EntityTreeArgs = {
    depth?: number;
    maxChildren?: number;
    includeComponents?: boolean;
};

type EntityComponentArgs = {
    entityId: number | string;
    componentNames?: string[] | null;
    includeScriptAttributes?: boolean | null;
    includeFullComponentData?: boolean | null;
};

type AssetTreeArgs = {
    maxSiblings?: number;
    maxChildren?: number;
};

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

const DEFAULT_SELECTION_LIMIT = 5;
const DEFAULT_ENTITY_DEPTH = 2;
const DEFAULT_TREE_CHILD_LIMIT = 6;
const DEFAULT_ASSET_SIBLING_LIMIT = 6;
const MAX_LIMIT = 20;
const MAX_DEPTH = 5;
const MAX_PARENT_TRAVERSAL = 64;
const MAX_COMPONENT_DEPTH = 5;
const MAX_COMPONENT_BREADTH = 40;
const MAX_SCRIPT_SUMMARY = 25;

const clampNumber = (value: unknown, fallback: number, min = 1, max = MAX_LIMIT) => {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, value));
};

const normalizeEntityId = (value: unknown): number | string | null => {
    if (typeof value === 'number') {
        return Number.isNaN(value) ? null : value;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length ? trimmed : null;
    }
    return null;
};

const toStringArray = (value: unknown): string[] => {
    if (!value) {
        return [];
    }
    if (Array.isArray(value)) {
        return value.filter((entry): entry is string => typeof entry === 'string');
    }

    if (typeof value === 'object') {
        const maybeObserverList = value as { array?: () => unknown[] };
        if (typeof maybeObserverList.array === 'function') {
            const arr = maybeObserverList.array();
            if (Array.isArray(arr)) {
                return arr.filter((entry): entry is string => typeof entry === 'string');
            }
        }
    }

    return [];
};

const buildEntityPath = (entity: Observer): string[] => {
    const names: string[] = [];
    const visited = new Set<string>();
    let current: Observer | null = entity;
    let depth = 0;

    while (current && depth < MAX_PARENT_TRAVERSAL) {
        const name = current.get('name') || '(Unnamed Entity)';
        names.push(name);

        const resourceId = current.get('resource_id');
        if (resourceId) {
            const key = String(resourceId);
            if (visited.has(key)) {
                break;
            }
            visited.add(key);
        }

        const parentId = current.get('parent');
        if (parentId === null || parentId === undefined) {
            break;
        }

        const parent = editor.call('entities:get', parentId);
        if (!parent) {
            names.push(`(Missing parent ${parentId})`);
            break;
        }

        current = parent;
        depth++;
    }

    return names.reverse();
};

const extractComponentNames = (entity: Observer): string[] => {
    const components = entity.get('components');
    if (!components || typeof components !== 'object') {
        return [];
    }

    return Object.keys(components).filter((key) => {
        const value = components[key];
        return !!value;
    });
};

const buildEntitySummary = (entity: Observer, includeComponents: boolean) => {
    const tags = toStringArray(entity.get('tags'));
    const componentNames = extractComponentNames(entity);
    const children = entity.get('children');
    const childCount = Array.isArray(children) ? children.length : 0;

    const summary: Record<string, unknown> = {
        id: entity.get('resource_id'),
        name: entity.get('name') || '(Unnamed Entity)',
        enabled: !!entity.get('enabled'),
        childCount,
        path: buildEntityPath(entity),
        tags
    };

    if (includeComponents && componentNames.length) {
        summary.components = componentNames;
    } else if (componentNames.length) {
        summary.componentCount = componentNames.length;
        summary.componentPreview = componentNames.slice(0, 5);
    }

    return summary;
};

const buildAssetPathNodes = (asset: Observer) => {
    const path = asset.get('path');
    const ids = Array.isArray(path) ? path : [];

    return ids.map((folderId) => {
        const folder = editor.call('assets:get', folderId);
        if (!folder) {
            return {
                id: folderId,
                name: '(Missing folder)',
                type: 'folder'
            };
        }

        return {
            id: folder.get('id'),
            name: folder.get('name') || '(Untitled folder)',
            type: folder.get('type')
        };
    });
};

const getAssetParentId = (asset: Observer): number | string | null => {
    const path = asset.get('path');
    if (!Array.isArray(path) || !path.length) {
        return null;
    }
    return path[path.length - 1];
};

const buildAssetSummary = (asset: Observer) => {
    const tags = toStringArray(asset.get('tags'));
    const file = asset.get('file');
    const pathNodes = buildAssetPathNodes(asset);
    const folderNames = pathNodes.map(node => node.name);
    const displayName = asset.get('name') || '(Untitled asset)';
    const fullPath = [...folderNames, displayName].filter(Boolean).join('/');
    const virtualPath = fullPath ? `/${fullPath}` : `/${displayName}`;

    const summary: Record<string, unknown> = {
        id: asset.get('id'),
        name: displayName,
        type: asset.get('type'),
        tags,
        path: folderNames,
        virtualPath,
        preload: !!asset.get('preload')
    };

    if (file) {
        summary.file = {
            filename: file.filename,
            size: file.size,
            hash: file.hash,
            variants: file.variants?.length
        };
    }

    return summary;
};

const sanitizeValue = (value: unknown, depth = MAX_COMPONENT_DEPTH): unknown => {
    if (depth <= 0) {
        return '[max-depth]';
    }

    if (value === null || value === undefined) {
        return null;
    }

    const valueType = typeof value;
    if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
        return value;
    }

    if (valueType === 'bigint') {
        return Number(value);
    }

    if (valueType === 'function') {
        return `[function ${value.name || 'anonymous'}]`;
    }

    if (Array.isArray(value)) {
        return value.slice(0, MAX_COMPONENT_BREADTH).map(entry => sanitizeValue(entry, depth - 1));
    }

    if (valueType === 'object') {
        const maybeObserver = value as { json?: () => unknown };
        const plain = typeof maybeObserver.json === 'function' ? maybeObserver.json() : value;
        if (!plain || typeof plain !== 'object') {
            return null;
        }

        const entries = Object.entries(plain).slice(0, MAX_COMPONENT_BREADTH);
        const result: Record<string, unknown> = {};
        for (const [key, entryValue] of entries) {
            result[key] = sanitizeValue(entryValue, depth - 1);
        }
        return result;
    }

    return null;
};

const normalizeComponentFilter = (value: unknown): string[] | null => {
    const entries = toStringArray(value).map(name => name.trim()).filter(Boolean);
    if (!entries.length) {
        return null;
    }
    return Array.from(new Set(entries));
};

const buildComponentSummary = (componentData: unknown, includeFullData: boolean) => {
    if (!componentData || typeof componentData !== 'object') {
        return {
            present: !!componentData
        };
    }

    const componentRecord = componentData as Record<string, unknown>;
    const summary: Record<string, unknown> = {
        propertyCount: Object.keys(componentRecord).length
    };

    if (Object.prototype.hasOwnProperty.call(componentRecord, 'enabled')) {
        const enabled = componentRecord.enabled;
        if (typeof enabled === 'boolean') {
            summary.enabled = enabled;
        }
    }

    if (includeFullData) {
        summary.data = sanitizeValue(componentData);
    }

    return summary;
};

const buildScriptInstanceSummary = (
    scriptName: string,
    rawData: Record<string, unknown> | undefined,
    orderIndex: number,
    includeAttributes: boolean
) => {
    const data = rawData && typeof rawData === 'object' ? rawData : {};
    const dataRecord = data as Record<string, unknown>;
    const attributes = dataRecord.attributes && typeof dataRecord.attributes === 'object' ? dataRecord.attributes as Record<string, unknown> : null;
    const attributeNames = attributes ? Object.keys(attributes) : [];
    const attributeCount = attributeNames.length;
    const asset = editor.call('assets:scripts:assetByScript', scriptName) as Observer | null;
    const collisions = editor.call('assets:scripts:collide', scriptName) as Record<string, Observer> | null | undefined;
    const collisionIds = collisions ? Object.keys(collisions) : [];

    const summary: Record<string, unknown> = {
        name: scriptName,
        enabled: typeof dataRecord.enabled === 'boolean' ? dataRecord.enabled : true,
        orderIndex: orderIndex >= 0 ? orderIndex : null,
        attributeCount,
        asset: asset ? buildAssetSummary(asset) : null
    };

    if (attributeCount) {
        if (includeAttributes && attributes) {
            summary.attributes = sanitizeValue(attributes, 4);
        } else {
            summary.attributeNames = attributeNames;
        }
    }

    if (Array.isArray(dataRecord.attributesOrder)) {
        summary.attributeOrder = dataRecord.attributesOrder;
    }

    if (collisionIds.length) {
        summary.assetCollisions = collisionIds.map((key) => {
            const numeric = Number(key);
            return Number.isNaN(numeric) ? key : numeric;
        });
    }

    const warnings: string[] = [];
    if (!asset) {
        warnings.push('Script object is not linked to a preloaded script asset.');
    }
    if (collisionIds.length) {
        warnings.push('Script name collides with multiple assets.');
    }
    if (warnings.length) {
        summary.warnings = warnings;
    }

    return summary;
};

const buildScriptComponentSummary = (entity: Observer, includeAttributes: boolean) => {
    const scriptComponent = entity.get('components.script');
    if (!scriptComponent || typeof scriptComponent !== 'object') {
        return null;
    }

    const scriptRecord = scriptComponent as Record<string, unknown>;

    const scripts = entity.get('components.script.scripts') as Record<string, Record<string, unknown> | undefined> | null;
    const order = entity.get('components.script.order');
    const orderList = Array.isArray(order) ? order.filter((entry): entry is string => typeof entry === 'string') : [];
    const scriptNames = scripts && typeof scripts === 'object' ? Object.keys(scripts) : [];
    const combinedNames = Array.from(new Set([...orderList, ...scriptNames]));
    const truncated = combinedNames.length > MAX_SCRIPT_SUMMARY ? combinedNames.length - MAX_SCRIPT_SUMMARY : 0;
    const visibleNames = combinedNames.slice(0, MAX_SCRIPT_SUMMARY);
    const scriptSummaries = visibleNames.map(name => buildScriptInstanceSummary(name, scripts?.[name], orderList.indexOf(name), includeAttributes));

    return {
        enabled: scriptRecord.enabled !== false,
        totalScripts: combinedNames.length,
        truncatedScripts: truncated || undefined,
        order: orderList,
        scripts: scriptSummaries
    };
};

type AssetCandidate = Observer | { observer?: Observer } | null | undefined;

const toAssetObserver = (candidate: AssetCandidate): Observer | null => {
    if (!candidate) {
        return null;
    }
    if (typeof candidate === 'object' && 'observer' in candidate) {
        const observer = candidate.observer;
        if (observer) {
            return observer;
        }
    }
    return candidate as Observer;
};

const formatError = (error: unknown) => {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === 'string' && error.trim().length) {
        return error.trim();
    }
    return 'Unknown error';
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
    return editor.call('assets:selected:folder') as Observer | null;
};

const updateScriptAsset = async (asset: Observer, contents: string, overrideFilename?: string | null) => {
    const currentFilename = asset.get('file')?.filename;
    const filename = (overrideFilename && overrideFilename.trim()) || currentFilename || `${asset.get('name') || 'script'}.js`;
    const blob = new Blob([contents], { type: scriptMimeFromFilename(filename) });

    const updated = await editor.api.globals.assets.upload({
        id: asset.get('id'),
        type: 'script',
        filename,
        file: blob
    });

    return toAssetObserver(updated) || asset;
};

const createScriptAsset = async (filename: string, contents: string, folder: Observer | null) => {
    const result = await editor.api.globals.assets.createScript({
        filename,
        folder,
        text: contents
    });

    // createScript already uploads the content, but return value is the API asset
    return toAssetObserver(result);
};

const describeSelectionTool: AssistantToolDefinition<SelectionToolArgs> = {
    name: 'describe_current_selection',
    description: 'Summarizes the current editor selection, including entity paths or asset metadata so the model can ground its response.',
    parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['maxItems', 'includeComponents'],
        properties: {
            maxItems: {
                type: ['number', 'null'],
                description: 'Maximum number of selected items to describe (default 5, max 20). Use null for defaults.'
            },
            includeComponents: {
                type: ['boolean', 'null'],
                description: 'Include the full component list for entities. Use null for defaults.'
            }
        }
    },
    handler: (rawArgs) => {
        const args = rawArgs || {};
        const maxItems = clampNumber(args.maxItems, DEFAULT_SELECTION_LIMIT);
        const includeComponents = typeof args.includeComponents === 'boolean' ? args.includeComponents : false;
        const selectionType = editor.call('selector:type');
        const items = (editor.call('selector:items') || []) as Observer[];

        if (!selectionType || !items.length) {
            return {
                selectionType: null,
                totalSelected: 0,
                items: [],
                message: 'No entities or assets are currently selected.'
            };
        }

        if (selectionType === 'entity') {
            return {
                selectionType,
                totalSelected: items.length,
                truncated: items.length > maxItems,
                items: items.slice(0, maxItems).map(entity => buildEntitySummary(entity, includeComponents))
            };
        }

        if (selectionType === 'asset') {
            return {
                selectionType,
                totalSelected: items.length,
                truncated: items.length > maxItems,
                items: items.slice(0, maxItems).map(asset => buildAssetSummary(asset))
            };
        }

        return {
            selectionType,
            totalSelected: items.length,
            items: [],
            message: `Selection type "${selectionType}" is not supported yet.`
        };
    }
};

const describeEntityComponentsTool: AssistantToolDefinition<EntityComponentArgs> = {
    name: 'describe_entity_components',
    description: 'Returns sanitized component data for a specific entity so the assistant can inspect script bindings and related settings.',
    parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['entityId', 'componentNames', 'includeScriptAttributes', 'includeFullComponentData'],
        properties: {
            entityId: {
                type: ['number', 'string'],
                description: 'resource_id or GUID of the entity returned by describe_current_selection.'
            },
            componentNames: {
                type: ['array', 'null'],
                items: {
                    type: 'string'
                },
                description: 'Optional list of component names to include. Defaults to all components.'
            },
            includeScriptAttributes: {
                type: ['boolean', 'null'],
                description: 'Include full attribute payloads for each script instance. Defaults to false to save tokens.'
            },
            includeFullComponentData: {
                type: ['boolean', 'null'],
                description: 'Include sanitized payloads for non-script components. Defaults to false so only summaries are returned.'
            }
        }
    },
    handler: (rawArgs) => {
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

        const componentFilter = normalizeComponentFilter(rawArgs.componentNames);
        const includeScriptAttributes = typeof rawArgs.includeScriptAttributes === 'boolean' ? rawArgs.includeScriptAttributes : false;
        const includeFullComponentData = typeof rawArgs.includeFullComponentData === 'boolean' ? rawArgs.includeFullComponentData : false;
        const shouldInclude = (name: string) => !componentFilter || componentFilter.includes(name);

        const components = entity.get('components');
        const componentMap = components && typeof components === 'object' ? components as Record<string, unknown> : null;
        const availableComponents = componentMap ? Object.keys(componentMap) : [];
        const payload: Record<string, unknown> = {};

        if (shouldInclude('script')) {
            payload.script = buildScriptComponentSummary(entity, includeScriptAttributes);
        }

        if (componentMap) {
            for (const name of availableComponents) {
                if (name === 'script') {
                    continue;
                }
                if (!shouldInclude(name)) {
                    continue;
                }
                payload[name] = buildComponentSummary(componentMap[name], includeFullComponentData);
            }
        }

        const missingComponents = componentFilter ? componentFilter.filter(name => name !== 'script' && !availableComponents.includes(name)) : [];
        if (componentFilter && componentFilter.includes('script')) {
            const hasScript = !!(componentMap && (componentMap as Record<string, unknown>).script);
            if (!hasScript) {
                missingComponents.push('script');
            }
        }

        return {
            entity: buildEntitySummary(entity, false),
            availableComponents,
            requestedComponents: componentFilter,
            missingComponents: missingComponents.length ? missingComponents : undefined,
            components: payload
        };
    }
};

const buildEntityTreeNode = (entity: Observer, depth: number, childLimit: number, includeComponents: boolean): Record<string, unknown> => {
    const node: Record<string, unknown> = {
        id: entity.get('resource_id'),
        name: entity.get('name') || '(Unnamed Entity)',
        path: buildEntityPath(entity)
    };

    const componentNames = extractComponentNames(entity);
    if (includeComponents && componentNames.length) {
        node.components = componentNames;
    } else if (componentNames.length) {
        node.componentCount = componentNames.length;
    }

    const children = entity.get('children');
    if (!Array.isArray(children) || !children.length) {
        return node;
    }

    if (depth <= 1) {
        node.childCount = children.length;
        return node;
    }

    const childNodes: Record<string, unknown>[] = [];
    let extraChildren = 0;
    for (const childId of children) {
        const child = editor.call('entities:get', childId);
        if (!child) {
            continue;
        }
        if (childNodes.length < childLimit) {
            childNodes.push(buildEntityTreeNode(child, depth - 1, childLimit, includeComponents));
        } else {
            extraChildren++;
        }
    }

    node.children = childNodes;
    if (extraChildren > 0) {
        node.moreChildren = extraChildren;
    }

    return node;
};

const describeEntityTreeTool: AssistantToolDefinition<EntityTreeArgs> = {
    name: 'describe_selected_entity_tree',
    description: 'Builds a lightweight hierarchy starting from the first selected entity, including parents and child previews.',
    parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['depth', 'maxChildren', 'includeComponents'],
        properties: {
            depth: {
                type: ['number', 'null'],
                description: 'Depth of the child traversal (default 2, max 5). Use null for defaults.'
            },
            maxChildren: {
                type: ['number', 'null'],
                description: 'Maximum number of child entities per level (default 6, max 20). Use null for defaults.'
            },
            includeComponents: {
                type: ['boolean', 'null'],
                description: 'Include component names at each node. Use null for defaults.'
            }
        }
    },
    handler: (rawArgs) => {
        const selectionType = editor.call('selector:type');
        if (selectionType !== 'entity') {
            return {
                warning: 'Entity selection required for describe_selected_entity_tree.',
                selectionType
            };
        }

        const items = (editor.call('selector:items') || []) as Observer[];
        if (!items.length) {
            return {
                warning: 'No entity is currently selected.'
            };
        }

        const args = rawArgs || {};
        const depth = clampNumber(args.depth, DEFAULT_ENTITY_DEPTH, 1, MAX_DEPTH);
        const maxChildren = clampNumber(args.maxChildren, DEFAULT_TREE_CHILD_LIMIT);
        const includeComponents = typeof args.includeComponents === 'boolean' ? args.includeComponents : false;

        const entity = items[0];
        return {
            selectionType,
            root: buildEntityTreeNode(entity, depth, maxChildren, includeComponents)
        };
    }
};

const buildAssetPreviewList = (asset: Observer, limit: number, predicate: (candidate: Observer, parentId: number | string | null) => boolean) => {
    const assets = (editor.call('assets:list') || []) as Observer[];
    const summary: Record<string, unknown>[] = [];
    let overflow = 0;

    for (const candidate of assets) {
        if (!predicate(candidate, getAssetParentId(candidate))) {
            continue;
        }
        if (candidate.get('id') === asset.get('id')) {
            continue;
        }

        if (summary.length < limit) {
            summary.push({
                id: candidate.get('id'),
                name: candidate.get('name') || '(Untitled asset)',
                type: candidate.get('type')
            });
        } else {
            overflow++;
        }
    }

    return {
        preview: summary,
        additionalCount: overflow
    };
};

const describeAssetTreeTool: AssistantToolDefinition<AssetTreeArgs> = {
    name: 'describe_selected_asset_tree',
    description: 'Describes the folder path and nearby assets for the first selected asset, helping the model understand project organization.',
    parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['maxSiblings', 'maxChildren'],
        properties: {
            maxSiblings: {
                type: ['number', 'null'],
                description: 'Maximum number of sibling assets to include (default 6, max 20). Use null for defaults.'
            },
            maxChildren: {
                type: ['number', 'null'],
                description: 'Maximum number of child assets to include when a folder is selected (default 6, max 20). Use null for defaults.'
            }
        }
    },
    handler: (rawArgs) => {
        const selectionType = editor.call('selector:type');
        if (selectionType !== 'asset') {
            return {
                warning: 'Asset selection required for describe_selected_asset_tree.',
                selectionType
            };
        }

        const items = (editor.call('selector:items') || []) as Observer[];
        if (!items.length) {
            return {
                warning: 'No asset is currently selected.'
            };
        }

        const args = rawArgs || {};
        const maxSiblings = clampNumber(args.maxSiblings, DEFAULT_ASSET_SIBLING_LIMIT);
        const maxChildren = clampNumber(args.maxChildren, DEFAULT_TREE_CHILD_LIMIT);
        const asset = items[0];
        const assetSummary = buildAssetSummary(asset);
        const parentPath = buildAssetPathNodes(asset);
        const parentId = getAssetParentId(asset);
        const type = asset.get('type');

        const payload: Record<string, unknown> = {
            selectionType,
            asset: assetSummary,
            pathNodes: parentPath
        };

        if (type === 'folder') {
            const childPreview = buildAssetPreviewList(asset, maxChildren, (candidate, candidateParentId) => candidateParentId === asset.get('id'));
            payload.children = childPreview.preview;
            if (childPreview.additionalCount > 0) {
                payload.moreChildren = childPreview.additionalCount;
            }
        } else {
            const siblingPreview = buildAssetPreviewList(asset, maxSiblings, (_candidate, candidateParentId) => candidateParentId === parentId);
            payload.siblings = siblingPreview.preview;
            if (siblingPreview.additionalCount > 0) {
                payload.moreSiblings = siblingPreview.additionalCount;
            }
        }

        return payload;
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

const writeScriptTool: AssistantToolDefinition<ScriptWriteArgs> = {
    name: 'write_script_asset',
    description: 'Creates a new script asset or overwrites an existing one with the provided contents.',
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

        try {
            if (assetId !== null) {
                const asset = getScriptAsset(assetId);
                const updatedAsset = await updateScriptAsset(asset, normalizedContents, filename);
                return {
                    action: 'updated',
                    asset: buildAssetSummary(updatedAsset),
                    characters: normalizedContents.length,
                    note: rawArgs.description || null
                };
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

            return {
                action: 'created',
                asset: buildAssetSummary(newAsset),
                characters: normalizedContents.length,
                note: rawArgs.description || null
            };
        } catch (error) {
            return {
                error: formatError(error)
            };
        }
    }
};

export const createAssistantTools = (): AssistantToolDefinition[] => [
    describeSelectionTool,
    describeEntityComponentsTool,
    describeEntityTreeTool,
    describeAssetTreeTool,
    readScriptTool,
    writeScriptTool
];
