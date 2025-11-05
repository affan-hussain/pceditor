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

type AssetTreeArgs = {
    maxSiblings?: number;
    maxChildren?: number;
};

const DEFAULT_SELECTION_LIMIT = 5;
const DEFAULT_ENTITY_DEPTH = 2;
const DEFAULT_TREE_CHILD_LIMIT = 6;
const DEFAULT_ASSET_SIBLING_LIMIT = 6;
const MAX_LIMIT = 20;
const MAX_DEPTH = 5;
const MAX_PARENT_TRAVERSAL = 64;

const clampNumber = (value: unknown, fallback: number, min = 1, max = MAX_LIMIT) => {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, value));
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
    const folderNames = pathNodes.map((node) => node.name);
    const displayName = asset.get('name') || '(Untitled asset)';

    const summary: Record<string, unknown> = {
        id: asset.get('id'),
        name: displayName,
        type: asset.get('type'),
        tags,
        path: folderNames,
        virtualPath: `/${[...folderNames, displayName].filter(Boolean).join('/')}` || `/${displayName}`,
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
                items: items.slice(0, maxItems).map((entity) => buildEntitySummary(entity, includeComponents))
            };
        }

        if (selectionType === 'asset') {
            return {
                selectionType,
                totalSelected: items.length,
                truncated: items.length > maxItems,
                items: items.slice(0, maxItems).map((asset) => buildAssetSummary(asset))
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

export const createAssistantTools = (): AssistantToolDefinition[] => [
    describeSelectionTool,
    describeEntityTreeTool,
    describeAssetTreeTool
];
