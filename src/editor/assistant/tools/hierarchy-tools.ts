import type { Observer } from '@playcanvas/observer';

import {
    MAX_PARENT_TRAVERSAL,
    MAX_REPARENT_OPERATIONS,
    buildEntitySummary,
    formatError,
    normalizeEntityId
} from './tool-common.ts';
import type { AssistantToolDefinition } from '../../../common/ai/assistant-client.ts';

type ReparentOperationInput = {
    entityId: number | string;
    parentId?: number | string | null;
    childIndex?: number | null;
};

type ReparentEntitiesArgs = {
    operations: ReparentOperationInput[];
    preserveTransform?: boolean | null;
    description?: string | null;
};

const KEEP_CURRENT_PARENT_TOKEN = '__current__';

const getSceneRoot = (): Observer => {
    const root = editor.call('entities:root') as Observer | null;
    if (!root) {
        throw new Error('Scene root entity is unavailable.');
    }
    return root;
};

const getParentObserver = (entity: Observer): Observer | null => {
    const parentId = entity.get('parent');
    if (parentId === undefined || parentId === null) {
        return null;
    }
    return editor.call('entities:get', parentId) as Observer | null;
};

const normalizeChildIndex = (rawIndex: unknown): number | null => {
    if (typeof rawIndex !== 'number' || Number.isNaN(rawIndex)) {
        return null;
    }
    return Math.max(0, Math.floor(rawIndex));
};

const isAncestorOf = (candidateAncestor: Observer, node: Observer): boolean => {
    let depth = 0;
    let current: Observer | null = node;

    while (current && depth < MAX_PARENT_TRAVERSAL) {
        if (current === candidateAncestor) {
            return true;
        }
        const parentId = current.get('parent');
        if (parentId === undefined || parentId === null) {
            break;
        }
        const parent = editor.call('entities:get', parentId) as Observer | null;
        if (!parent) {
            break;
        }
        current = parent;
        depth++;
    }

    return false;
};

const getTemplateRoot = (entity: Observer): Observer | null => {
    try {
        const templateRoot = editor.call('templates:isTemplateChild', entity) as Observer | null;
        return templateRoot || null;
    } catch (error) {
        console.warn('[Assistant] Failed to resolve template membership for entity.', error);
        return null;
    }
};

const canReparentWithinTemplate = (
    entity: Observer,
    newParent: Observer,
    cache: Map<Observer, Observer | null>
) => {
    const childRoot = getTemplateRoot(entity);
    if (!childRoot) {
        return true;
    }

    let parentRoot = cache.get(newParent);
    if (parentRoot === undefined) {
        parentRoot = newParent.get('template_id') ? newParent : getTemplateRoot(newParent);
        cache.set(newParent, parentRoot || null);
    }

    return parentRoot === childRoot;
};

const reparentEntitiesTool: AssistantToolDefinition<ReparentEntitiesArgs> = {
    name: 'reparent_entities_in_hierarchy',
    description: 'Moves entities under a different parent or changes their sibling order so the assistant can restructure the scene hierarchy. Set parentId to "__current__" when you only want to reorder children under the existing parent.',
    parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['operations', 'preserveTransform', 'description'],
        properties: {
            operations: {
                type: 'array',
                minItems: 1,
                description: 'List of entity moves to apply (processed up to 10 entries per call).',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['entityId', 'parentId', 'childIndex'],
                    properties: {
                        entityId: {
                            type: ['number', 'string'],
                            description: 'resource_id or GUID of the entity to move.'
                        },
                        parentId: {
                            type: ['number', 'string', 'null'],
                            description: 'New parent entity id, "__current__" to keep the existing parent, or null to attach to the scene root.'
                        },
                        childIndex: {
                            type: ['number', 'null'],
                            description: 'Zero-based index under the new parent. Use null to append to the end.'
                        }
                    }
                }
            },
            preserveTransform: {
                type: ['boolean', 'null'],
                description: 'Preserve world transforms during the move (defaults to true).'
            },
            description: {
                type: ['string', 'null'],
                description: 'Optional note explaining why the hierarchy was changed.'
            }
        }
    },
    handler: (rawArgs) => {
        if (!editor.call('permissions:write')) {
            return {
                error: 'Write permission is required to modify the scene hierarchy.'
            };
        }

        const operations = Array.isArray(rawArgs?.operations) ? rawArgs.operations : null;
        if (!operations || !operations.length) {
            return {
                error: 'operations must be a non-empty array.'
            };
        }

        let sceneRoot: Observer;
        try {
            sceneRoot = getSceneRoot();
        } catch (error) {
            return {
                error: formatError(error)
            };
        }

        let description: string | null = null;
        if (typeof rawArgs?.description === 'string') {
            const trimmed = rawArgs.description.trim();
            if (trimmed.length) {
                description = trimmed;
            }
        }
        const preserveTransform = typeof rawArgs?.preserveTransform === 'boolean' ? rawArgs.preserveTransform : true;
        const sceneRootSummary = buildEntitySummary(sceneRoot, false);
        const limitedOperations = operations.slice(0, MAX_REPARENT_OPERATIONS);
        const truncated = operations.length > limitedOperations.length;
        const results: Record<string, unknown>[] = [];
        const movesToApply: { entity: Observer; parent: Observer; index: number | null; result: Record<string, unknown> }[] = [];
        const processedEntities = new Set<string>();
        const templateRootCache = new Map<Observer, Observer | null>();

        for (const entry of limitedOperations) {
            if (!entry || typeof entry !== 'object') {
                results.push({
                    status: 'error',
                    error: 'Each operations entry must be an object.'
                });
                continue;
            }

            const normalizedEntityId = normalizeEntityId((entry as { entityId?: unknown }).entityId);
            if (normalizedEntityId === null) {
                results.push({
                    status: 'error',
                    error: 'Each operations entry must include a valid entityId.'
                });
                continue;
            }

            const entity = editor.call('entities:get', normalizedEntityId) as Observer | null;
            if (!entity) {
                results.push({
                    entityId: normalizedEntityId,
                    status: 'error',
                    error: `No entity found with id ${normalizedEntityId}.`
                });
                continue;
            }

            const entityKey = typeof normalizedEntityId === 'number' ? `n:${normalizedEntityId}` : `s:${normalizedEntityId}`;
            if (processedEntities.has(entityKey)) {
                results.push({
                    entity: buildEntitySummary(entity, false),
                    status: 'error',
                    error: 'Each entity can only be moved once per tool call.'
                });
                continue;
            }

            processedEntities.add(entityKey);

            if (entity === sceneRoot) {
                results.push({
                    entity: buildEntitySummary(entity, false),
                    status: 'error',
                    error: 'The scene root entity cannot be reparented.'
                });
                continue;
            }

            const rawParentValue = entity.get('parent');
            const previousParent = getParentObserver(entity);

            const rawParentOverride = (entry as { parentId?: unknown }).parentId;
            const usesCurrentParent = typeof rawParentOverride === 'string' &&
                rawParentOverride.trim().toLowerCase() === KEEP_CURRENT_PARENT_TOKEN;
            const normalizedParentId = usesCurrentParent ? undefined : normalizeEntityId(rawParentOverride);
            let targetParent: Observer | null = null;
            let parentResolutionError: string | null = null;

            if (usesCurrentParent) {
                targetParent = previousParent ?? sceneRoot;
            } else if (rawParentOverride === null) {
                targetParent = sceneRoot;
            } else if (normalizedParentId !== null && normalizedParentId !== undefined) {
                targetParent = editor.call('entities:get', normalizedParentId) as Observer | null;
            } else {
                parentResolutionError = 'parentId must be null, "__current__", or a valid entity id/GUID.';
            }

            if (!targetParent) {
                results.push({
                    entity: buildEntitySummary(entity, false),
                    status: 'error',
                    error: parentResolutionError || 'Unable to resolve the target parent entity.'
                });
                continue;
            }

            const parentSummary = targetParent === sceneRoot ? sceneRootSummary : buildEntitySummary(targetParent, false);

            if (targetParent === entity) {
                results.push({
                    entity: buildEntitySummary(entity, false),
                    status: 'error',
                    error: 'Cannot reparent an entity under itself.'
                });
                continue;
            }

            if (isAncestorOf(entity, targetParent)) {
                results.push({
                    entity: buildEntitySummary(entity, false),
                    targetParent: parentSummary,
                    status: 'error',
                    error: 'Cannot reparent an entity under one of its descendants.'
                });
                continue;
            }

            if (!canReparentWithinTemplate(entity, targetParent, templateRootCache)) {
                results.push({
                    entity: buildEntitySummary(entity, false),
                    targetParent: parentSummary,
                    status: 'error',
                    error: 'Entities that belong to a template can only move within the same template root.'
                });
                continue;
            }

            const targetIndex = normalizeChildIndex((entry as { childIndex?: unknown }).childIndex);
            let previousParentSummary: Record<string, unknown> | null = null;
            if (previousParent) {
                previousParentSummary = buildEntitySummary(previousParent, false);
            } else if (rawParentValue === undefined || rawParentValue === null) {
                previousParentSummary = sceneRootSummary;
            }

            const result: Record<string, unknown> = {
                entity: buildEntitySummary(entity, false),
                previousParent: previousParentSummary,
                targetParent: parentSummary,
                requestedIndex: typeof targetIndex === 'number' ? targetIndex : null,
                status: 'pending'
            };

            movesToApply.push({
                entity,
                parent: targetParent,
                index: targetIndex,
                result
            });
            results.push(result);
        }

        let appliedMoves = 0;
        for (const move of movesToApply) {
            try {
                editor.call('entities:reparent', [{
                    entity: move.entity,
                    parent: move.parent,
                    index: typeof move.index === 'number' ? move.index : undefined
                }], preserveTransform);
                move.result.status = 'moved';
                move.result.appliedIndex = typeof move.index === 'number' ? move.index : null;
                appliedMoves++;
            } catch (error) {
                move.result.status = 'error';
                move.result.error = formatError(error);
            }
        }

        if (appliedMoves > 0) {
            try {
                editor.call('viewport:render');
            } catch (error) {
                console.warn('[Assistant] Failed to trigger viewport render after reparenting.', error);
            }
        }

        return {
            preserveTransform,
            requestedOperations: results.length,
            appliedOperations: appliedMoves,
            truncated: truncated || undefined,
            note: description,
            results
        };
    }
};

export const createHierarchyTools = (): AssistantToolDefinition[] => [
    reparentEntitiesTool
];
