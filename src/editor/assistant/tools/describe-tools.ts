import type { Observer } from '@playcanvas/observer';

import {
    DEFAULT_SELECTION_LIMIT,
    DEFAULT_ENTITY_DEPTH,
    DEFAULT_TREE_CHILD_LIMIT,
    DEFAULT_ASSET_SIBLING_LIMIT,
    DEFAULT_ROOT_SUMMARY_LIMIT,
    DEFAULT_ENTITY_QUERY_LIMIT,
    DEFAULT_SCENE_SETTINGS_DEPTH,
    MAX_SCENE_SETTINGS_DEPTH,
    MAX_DEPTH,
    clampNumber,
    normalizeEntityId,
    toStringArray,
    buildEntitySummary,
    buildAssetSummary,
    buildScriptComponentSummary,
    buildEntityPath,
    extractComponentNames,
    buildAssetPathNodes,
    getAssetParentId,
    sanitizeValue,
    normalizeComponentFilter,
    buildComponentSummary,
    buildHistogramEntries,
    listAllEntities,
    listRootEntities,
    gatherSceneEntityStats,
    normalizeSectionFilter,
    getSceneSettingsSnapshot
} from './tool-common.ts';
import type { AssistantToolDefinition } from '../../../common/ai/assistant-client.ts';

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

type SceneOverviewArgs = {
    maxRoots?: number | null;
    includeComponents?: boolean | null;
    includeStats?: boolean | null;
};

type FindEntitiesArgs = {
    nameContains?: string | null;
    tags?: string[] | null;
    components?: string[] | null;
    limit?: number | null;
    includeComponents?: boolean | null;
};

type SceneSettingsArgs = {
    sections?: string[] | null;
    maxDepth?: number | null;
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

const describeSceneOverviewTool: AssistantToolDefinition<SceneOverviewArgs> = {
    name: 'describe_scene_overview',
    description: 'Summarizes the full scene graph, including root entities and high-level statistics so the assistant can understand the project structure.',
    parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['maxRoots', 'includeComponents', 'includeStats'],
        properties: {
            maxRoots: {
                type: ['number', 'null'],
                description: 'Maximum number of root entities to include in the overview (default 8, max 20). Use null for defaults.'
            },
            includeComponents: {
                type: ['boolean', 'null'],
                description: 'Include component names for each root entity.'
            },
            includeStats: {
                type: ['boolean', 'null'],
                description: 'Include aggregated component and tag statistics.'
            }
        }
    },
    handler: (rawArgs) => {
        const entities = listAllEntities();
        const args = rawArgs || {};
        const maxRoots = clampNumber(args.maxRoots, DEFAULT_ROOT_SUMMARY_LIMIT);
        const includeComponents = typeof args.includeComponents === 'boolean' ? args.includeComponents : false;
        const includeStats = typeof args.includeStats === 'boolean' ? args.includeStats : true;

        const roots = listRootEntities();
        const rootSummaries = roots.slice(0, maxRoots).map(entity => buildEntitySummary(entity, includeComponents));
        const payload: Record<string, unknown> = {
            totalEntities: entities.length,
            rootCount: roots.length,
            roots: rootSummaries
        };

        if (roots.length > maxRoots) {
            payload.moreRoots = roots.length - maxRoots;
        }

        if (!entities.length) {
            payload.message = 'No entities are currently loaded in the scene.';
            return payload;
        }

        if (!roots.length) {
            payload.warning = 'Scene has no root entities. The project hierarchy may still be loading.';
        }

        if (includeStats) {
            const stats = gatherSceneEntityStats(entities);
            payload.enabledEntities = stats.enabledCount;
            payload.scriptEntities = stats.scriptEntityCount;
            payload.componentStats = buildHistogramEntries(stats.componentHistogram);
            payload.tagStats = buildHistogramEntries(stats.tagHistogram);
        }

        return payload;
    }
};

const findEntitiesTool: AssistantToolDefinition<FindEntitiesArgs> = {
    name: 'find_entities',
    description: 'Searches the entire scene for entities that match by name, tags, or component types.',
    parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['nameContains', 'tags', 'components', 'limit', 'includeComponents'],
        properties: {
            nameContains: {
                type: ['string', 'null'],
                description: 'Substring match applied to entity names (case-insensitive).'
            },
            tags: {
                type: ['array', 'null'],
                items: {
                    type: 'string'
                },
                description: 'List of tags that every returned entity must include.'
            },
            components: {
                type: ['array', 'null'],
                items: {
                    type: 'string'
                },
                description: 'List of component names that every returned entity must include.'
            },
            limit: {
                type: ['number', 'null'],
                description: 'Maximum number of results (default 10, max 20).'
            },
            includeComponents: {
                type: ['boolean', 'null'],
                description: 'Include the component list for each entity summary.'
            }
        }
    },
    handler: (rawArgs) => {
        const entities = listAllEntities();
        if (!entities.length) {
            return {
                totalEntities: 0,
                matches: [],
                message: 'Scene has no entities to search.'
            };
        }

        const args = rawArgs || {};
        const limit = clampNumber(args.limit, DEFAULT_ENTITY_QUERY_LIMIT);
        const includeComponents = typeof args.includeComponents === 'boolean' ? args.includeComponents : false;
        const nameFilter = typeof args.nameContains === 'string' ? args.nameContains.trim().toLowerCase() : '';
        const tagFilter = normalizeComponentFilter(args.tags)?.map(tag => tag.toLowerCase()) || null;
        const componentFilter = normalizeComponentFilter(args.components);
        const matches: Record<string, unknown>[] = [];
        let totalMatches = 0;

        for (const entity of entities) {
            const name = (entity.get('name') || '').toLowerCase();
            if (nameFilter && name.indexOf(nameFilter) === -1) {
                continue;
            }

            const tags = toStringArray(entity.get('tags'));
            const lowerTags = tags.map(tag => tag.toLowerCase());
            if (tagFilter && !tagFilter.every(tag => lowerTags.includes(tag))) {
                continue;
            }

            const components = extractComponentNames(entity);
            if (componentFilter && !componentFilter.every(component => components.includes(component))) {
                continue;
            }

            totalMatches++;
            if (matches.length < limit) {
                matches.push(buildEntitySummary(entity, includeComponents));
            }
        }

        return {
            totalEntities: entities.length,
            totalMatches,
            truncated: totalMatches > matches.length,
            filters: {
                nameContains: nameFilter || undefined,
                tags: tagFilter || undefined,
                components: componentFilter || undefined
            },
            matches
        };
    }
};

const describeSceneSettingsTool: AssistantToolDefinition<SceneSettingsArgs> = {
    name: 'describe_scene_settings',
    description: 'Returns sanitized project scene settings (rendering, physics, etc.) so the assistant can understand the global environment.',
    parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['sections', 'maxDepth'],
        properties: {
            sections: {
                type: ['array', 'null'],
                items: {
                    type: 'string'
                },
                description: 'Optional list of section names (e.g. render, physics). Defaults to all sections.'
            },
            maxDepth: {
                type: ['number', 'null'],
                description: 'Maximum depth when sanitizing nested settings (default 4, max 8).'
            }
        }
    },
    handler: (rawArgs) => {
        const snapshot = getSceneSettingsSnapshot();
        if (!snapshot) {
            return {
                error: 'Scene settings are not available yet.'
            };
        }

        const args = rawArgs || {};
        const requestedSections = normalizeSectionFilter(args.sections);
        const maxDepth = clampNumber(args.maxDepth, DEFAULT_SCENE_SETTINGS_DEPTH, 1, MAX_SCENE_SETTINGS_DEPTH);
        const availableSections = Object.keys(snapshot.data);

        const lowerSectionMap = new Map<string, string>();
        for (const sectionName of availableSections) {
            lowerSectionMap.set(sectionName.toLowerCase(), sectionName);
        }

        const sectionsToInclude = (!requestedSections || !requestedSections.length) ?
            availableSections.map(section => section.toLowerCase()) :
            requestedSections;
        const included: Record<string, unknown> = {};
        for (const sectionName of sectionsToInclude) {
            const resolved = lowerSectionMap.get(sectionName) || sectionName;
            if (!Object.prototype.hasOwnProperty.call(snapshot.data, resolved)) {
                continue;
            }
            included[resolved] = sanitizeValue(snapshot.data[resolved], maxDepth);
        }

        if (!Object.keys(included).length) {
            return {
                availableSections,
                requestedSections,
                warning: 'Requested sections were not found in the current scene settings.'
            };
        }

        return {
            availableSections,
            requestedSections,
            includedSections: Object.keys(included),
            settings: included
        };
    }
};

export const createDescribeTools = (): AssistantToolDefinition[] => [
    describeSelectionTool,
    describeSceneOverviewTool,
    findEntitiesTool,
    describeEntityComponentsTool,
    describeEntityTreeTool,
    describeAssetTreeTool,
    describeSceneSettingsTool
];
