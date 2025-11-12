import type { Observer } from '@playcanvas/observer';

export const DEFAULT_SELECTION_LIMIT = 5;
export const DEFAULT_ENTITY_DEPTH = 2;
export const DEFAULT_TREE_CHILD_LIMIT = 6;
export const DEFAULT_ASSET_SIBLING_LIMIT = 6;
export const DEFAULT_ROOT_SUMMARY_LIMIT = 8;
export const DEFAULT_ENTITY_QUERY_LIMIT = 10;
export const DEFAULT_SCENE_SETTINGS_DEPTH = 4;
export const DEFAULT_SCRIPT_USAGE_LIMIT = 10;
export const DEFAULT_ASSET_USAGE_LIMIT = 10;
export const MAX_LIMIT = 20;
export const MAX_DEPTH = 5;
export const MAX_PARENT_TRAVERSAL = 64;
export const MAX_COMPONENT_DEPTH = 5;
export const MAX_COMPONENT_BREADTH = 40;
export const MAX_SCENE_SETTINGS_DEPTH = 8;
export const MAX_STAT_ENTRIES = 10;
export const MAX_SCRIPT_SUMMARY = 25;
export const MAX_UPDATE_DEPTH = 8;
export const MAX_SCRIPT_CONFIGS = 10;
export const MAX_COMPONENT_CONFIGS = 10;
export const MAX_SCRIPT_ATTRIBUTE_REMOVALS = 20;
export const MAX_SCRIPT_ATTRIBUTE_UPDATES = 40;
export const MAX_COMPONENT_PROPERTY_UPDATES = 60;
export const MAX_MATERIAL_UPDATES = 80;
export const MAX_DATA_REMOVALS = 40;

export type AssetsUsedIndexEntry = {
    count: number;
    parent: number;
    ref: Record<string, unknown>;
};

export const clampNumber = (value: unknown, fallback: number, min = 1, max = MAX_LIMIT) => {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, value));
};

export const normalizeEntityId = (value: unknown): number | string | null => {
    if (typeof value === 'number') {
        return Number.isNaN(value) ? null : value;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length ? trimmed : null;
    }
    return null;
};

export const toStringArray = (value: unknown): string[] => {
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

export const buildEntityPath = (entity: Observer): string[] => {
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

export const extractComponentNames = (entity: Observer): string[] => {
    const components = entity.get('components');
    if (!components || typeof components !== 'object') {
        return [];
    }

    return Object.keys(components).filter((key) => {
        const value = components[key];
        return !!value;
    });
};

export const buildEntitySummary = (entity: Observer, includeComponents: boolean) => {
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

export const buildAssetPathNodes = (asset: Observer) => {
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

export const getAssetParentId = (asset: Observer): number | string | null => {
    const path = asset.get('path');
    if (!Array.isArray(path) || !path.length) {
        return null;
    }
    return path[path.length - 1];
};

export const buildAssetSummary = (asset: Observer) => {
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

export const sanitizeValue = (value: unknown, depth = MAX_COMPONENT_DEPTH): unknown => {
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

export const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    if (!value || typeof value !== 'object') {
        return false;
    }
    if (Array.isArray(value)) {
        return false;
    }
    if (value instanceof Observer) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
};

export const normalizeComponentFilter = (value: unknown): string[] | null => {
    const entries = toStringArray(value).map(name => name.trim()).filter(Boolean);
    if (!entries.length) {
        return null;
    }
    return Array.from(new Set(entries));
};

export const buildComponentSummary = (componentData: unknown, includeFullData: boolean) => {
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

export const buildScriptInstanceSummary = (
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

export const buildScriptComponentSummary = (entity: Observer, includeAttributes: boolean) => {
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

export const buildScriptUsageEntitySummary = (
    entity: Observer,
    scriptName: string,
    includeComponents: boolean,
    includeAttributes: boolean
) => {
    const summary = buildEntitySummary(entity, includeComponents);
    if (!includeAttributes) {
        return summary;
    }

    const scriptData = entity.get(`components.script.scripts.${scriptName}`);
    if (scriptData && typeof scriptData === 'object') {
        const scriptRecord = scriptData as Record<string, unknown>;
        const attributes = scriptRecord.attributes;
        if (attributes && typeof attributes === 'object') {
            summary.scriptAttributes = sanitizeValue(attributes, 4);
        }
        if (Object.prototype.hasOwnProperty.call(scriptRecord, 'enabled')) {
            const enabled = scriptRecord.enabled;
            if (typeof enabled === 'boolean') {
                summary.scriptEnabled = enabled;
            }
        }
    }

    return summary;
};

export const listAllEntities = () => {
    const entities = editor.call('entities:list');
    if (!Array.isArray(entities)) {
        return [] as Observer[];
    }
    return entities as Observer[];
};

export const listRootEntities = () => {
    const roots: Observer[] = [];
    const sceneRoot = editor.call('entities:root') as Observer | null;
    const children = sceneRoot?.get('children');
    if (Array.isArray(children) && children.length) {
        for (const childId of children) {
            const child = editor.call('entities:get', childId);
            if (child) {
                roots.push(child);
            }
        }
        return roots;
    }

    const entities = listAllEntities();
    for (const entity of entities) {
        const parent = entity.get('parent');
        if (parent === null || parent === undefined) {
            roots.push(entity);
        }
    }
    return roots;
};

export const buildHistogramEntries = (histogram: Record<string, number>, maxEntries = MAX_STAT_ENTRIES) => {
    return Object.entries(histogram)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxEntries)
    .map(([name, count]) => ({ name, count }));
};

export const gatherSceneEntityStats = (entities: Observer[]) => {
    const componentHistogram: Record<string, number> = {};
    const tagHistogram: Record<string, number> = {};
    let enabledCount = 0;
    let scriptEntityCount = 0;

    for (const entity of entities) {
        if (entity.get('enabled') !== false) {
            enabledCount++;
        }

        const components = extractComponentNames(entity);
        if (components.includes('script')) {
            scriptEntityCount++;
        }

        for (const component of components) {
            componentHistogram[component] = (componentHistogram[component] || 0) + 1;
        }

        const tags = toStringArray(entity.get('tags'));
        for (const tag of tags) {
            if (!tag) {
                continue;
            }
            tagHistogram[tag] = (tagHistogram[tag] || 0) + 1;
        }
    }

    return {
        enabledCount,
        scriptEntityCount,
        componentHistogram,
        tagHistogram
    };
};

export const normalizeSectionFilter = (value: unknown): string[] | null => {
    const entries = toStringArray(value).map(entry => entry.trim().toLowerCase()).filter(Boolean);
    if (!entries.length) {
        return null;
    }
    return Array.from(new Set(entries));
};

export const getSceneSettingsSnapshot = () => {
    const settings = editor.call('sceneSettings') as Observer | null;
    if (!settings) {
        return null;
    }
    const json = typeof settings.json === 'function' ? settings.json() : null;
    if (!json || typeof json !== 'object') {
        return null;
    }
    return { observer: settings, data: json as Record<string, unknown> };
};

export const extractScriptNamesFromAsset = (asset: Observer | null | undefined) => {
    if (!asset) {
        return [];
    }
    const scripts = asset.get('data.scripts');
    if (!scripts || typeof scripts !== 'object') {
        return [];
    }
    return Object.keys(scripts);
};

export const resolveScriptNames = (args: { scriptName?: string | null; assetId?: number | null }) => {
    const names = new Set<string>();
    const explicitName = typeof args.scriptName === 'string' ? args.scriptName.trim() : '';
    if (explicitName) {
        names.add(explicitName);
    }

    if (typeof args.assetId === 'number') {
        try {
            const asset = editor.call('assets:get', args.assetId) as Observer | null;
            if (asset && asset.get('type') === 'script') {
                const assetScripts = extractScriptNamesFromAsset(asset);
                for (const scriptName of assetScripts) {
                    names.add(scriptName);
                }
            } else {
                throw new Error(`Asset ${args.assetId} is not a script.`);
            }
        } catch (error) {
            console.warn('[Assistant] script asset resolution failed', error);
        }
    }

    return Array.from(names);
};

export const getAssetsUsedIndex = () => {
    const index = editor.call('assets:used:index');
    if (!index || typeof index !== 'object') {
        return null;
    }
    return index as Record<string | number, AssetsUsedIndexEntry>;
};

export const getReferenceType = (refEntry: unknown): string | null => {
    if (refEntry && typeof refEntry === 'object' && 'type' in refEntry) {
        const maybeType = (refEntry as { type?: unknown }).type;
        if (typeof maybeType === 'string' && maybeType.trim().length) {
            return maybeType;
        }
    }
    return null;
};

export const parseIdValue = (value: string): number | string => {
    const numeric = Number(value);
    return Number.isNaN(numeric) ? value : numeric;
};

export const cloneWritableValue = (value: unknown, depth = 0): unknown => {
    if (depth > MAX_UPDATE_DEPTH) {
        return null;
    }
    if (Array.isArray(value)) {
        return value.map(entry => cloneWritableValue(entry, depth + 1));
    }
    if (isPlainObject(value)) {
        const result: Record<string, unknown> = {};
        for (const [key, entryValue] of Object.entries(value)) {
            result[key] = cloneWritableValue(entryValue, depth + 1);
        }
        return result;
    }
    if (typeof value === 'number') {
        if (Number.isNaN(value)) {
            return null;
        }
        if (!Number.isFinite(value)) {
            return value > 0 ? Number.MAX_SAFE_INTEGER : Number.MIN_SAFE_INTEGER;
        }
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    return value;
};

export const applyObserverRemovals = (
    observer: Observer,
    basePath: string,
    removals: unknown,
    changedPaths: string[],
    limit = MAX_DATA_REMOVALS
) => {
    if (!Array.isArray(removals) || !removals.length) {
        return;
    }
    const entries = removals.slice(0, limit);
    for (const entry of entries) {
        if (typeof entry !== 'string') {
            continue;
        }
        const trimmed = entry.trim();
        if (!trimmed.length) {
            continue;
        }
        const path = basePath ? `${basePath}.${trimmed}` : trimmed;
        if (observer.has && !observer.has(path)) {
            continue;
        }
        observer.unset(path);
        changedPaths.push(path);
    }
};

export const formatError = (error: unknown) => {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === 'string' && error.trim().length) {
        return error.trim();
    }
    return 'Unknown error';
};
