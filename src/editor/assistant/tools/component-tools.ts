import type { Observer } from '@playcanvas/observer';

import {
    MAX_COMPONENT_CONFIGS,
    MAX_COMPONENT_PROPERTY_UPDATES,
    MAX_DATA_REMOVALS,
    normalizeEntityId,
    buildEntitySummary,
    cloneWritableValue,
    applyObserverRemovals,
    formatError
} from './tool-common.ts';
import type { AssistantToolDefinition } from '../../../common/ai/assistant-client.ts';

type ComponentPropertyUpdate = {
    path: string;
    value?: string | number | boolean | null;
    jsonValue?: string | null;
};

type ComponentConfigInput = {
    name: string;
    action?: 'add' | 'ensure' | 'update' | 'remove' | 'delete' | null;
    enabled?: boolean | null;
    properties?: ComponentPropertyUpdate[] | null;
    removals?: string[] | null;
};

type ConfigureComponentsArgs = {
    entityId: number | string;
    components: ComponentConfigInput[];
    description?: string | null;
};

const getComponentLookup = () => {
    const entries = editor.call('components:list');
    if (!Array.isArray(entries) || !entries.length) {
        return null;
    }
    const lookup = new Map<string, string>();
    for (const entry of entries) {
        if (typeof entry !== 'string') {
            continue;
        }
        const name = entry.trim();
        if (!name) {
            continue;
        }
        lookup.set(name.toLowerCase(), entry);
    }
    return lookup;
};

const normalizeComponentName = (rawName: string, lookup: Map<string, string> | null) => {
    const trimmed = rawName.trim();
    if (!trimmed) {
        return '';
    }
    if (!lookup) {
        return trimmed.toLowerCase();
    }
    const resolved = lookup.get(trimmed.toLowerCase());
    if (resolved) {
        return resolved;
    }
    return trimmed.toLowerCase();
};

const ensureComponentExists = (entity: Observer, componentName: string) => {
    const apiEntity = entity.apiEntity;
    if (!apiEntity) {
        throw new Error('Entity API bridge is unavailable.');
    }

    const historyState = typeof entity.history?.enabled === 'boolean' ? entity.history.enabled : null;
    try {
        if (historyState !== null) {
            entity.history.enabled = false;
        }
        apiEntity.addComponent(componentName, {});
    } finally {
        if (historyState !== null) {
            entity.history.enabled = historyState;
        }
    }
};

const normalizePropertyPath = (componentName: string, rawPath: string) => {
    let path = rawPath.trim();
    if (!path) {
        return '';
    }
    const componentPrefix = `${componentName}.`;
    const fullPrefix = `components.${componentPrefix}`;
    if (path.startsWith(fullPrefix)) {
        path = path.slice(fullPrefix.length);
    } else if (path.startsWith(componentPrefix)) {
        path = path.slice(componentPrefix.length);
    } else if (path.startsWith('components.')) {
        const remainder = path.slice('components.'.length);
        if (remainder.startsWith(componentPrefix)) {
            path = remainder.slice(componentPrefix.length);
        }
    }
    if (path.startsWith('.')) {
        path = path.slice(1);
    }
    return path;
};

const configureEntityComponentsTool: AssistantToolDefinition<ConfigureComponentsArgs> = {
    name: 'configure_entity_components',
    description: 'Adds components like rigidbody or collision to an entity and updates their properties so the assistant can wire up gameplay features.',
    parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['entityId', 'description', 'components'],
        properties: {
            entityId: {
                type: ['number', 'string'],
                description: 'resource_id or GUID of the entity to modify.'
            },
            description: {
                type: ['string', 'null'],
                description: 'Optional note about why the change was made.'
            },
            components: {
                type: 'array',
                minItems: 1,
                description: 'List of component operations to perform (add/update/remove).',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['name', 'action', 'enabled', 'properties', 'removals'],
                    properties: {
                        name: {
                            type: 'string',
                            description: 'Component name (e.g. "rigidbody", "collision").'
                        },
                        action: {
                            type: ['string', 'null'],
                            description: 'Action to take: "add", "ensure", "update", or "remove". Use null to apply defaults (update existing component only).'
                        },
                        enabled: {
                            type: ['boolean', 'null'],
                            description: 'Set the component enabled flag; null leaves it unchanged.'
                        },
                        properties: {
                            type: ['array', 'null'],
                            description: 'List of property assignments relative to the component root (use null when no updates are needed).',
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                required: ['path', 'value', 'jsonValue'],
                                properties: {
                                    path: {
                                        type: 'string',
                                        description: 'Dot-separated path relative to the component (e.g. "mass", "axis.x").'
                                    },
                                    value: {
                                        type: ['string', 'number', 'boolean', 'null'],
                                        description: 'Primitive value applied when jsonValue is omitted.'
                                    },
                                    jsonValue: {
                                        type: ['string', 'null'],
                                        description: 'Optional JSON payload for arrays/objects; overrides the primitive value.'
                                    }
                                }
                            }
                        },
                        removals: {
                            type: ['array', 'null'],
                            description: 'List of property paths (relative to the component) to delete; use null to skip removals.',
                            items: {
                                type: 'string'
                            }
                        }
                    }
                }
            }
        }
    },
    handler: (rawArgs) => {
        if (!editor.call('permissions:write')) {
            return {
                error: 'Write permission is required to modify entity components.'
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

        if (!Array.isArray(rawArgs?.components) || !rawArgs.components.length) {
            return {
                error: 'components must be a non-empty array.'
            };
        }

        const componentLookup = getComponentLookup();
        const limitedComponents = rawArgs.components.slice(0, MAX_COMPONENT_CONFIGS);
        const operations: Record<string, unknown>[] = [];

        for (const config of limitedComponents) {
            if (!config || typeof config !== 'object') {
                return {
                    error: 'Each entry in components must be an object.'
                };
            }

            const rawName = typeof config.name === 'string' ? config.name : '';
            const componentName = normalizeComponentName(rawName, componentLookup);
            if (!componentName) {
                return {
                    error: 'Each component entry requires a non-empty "name".'
                };
            }

            if (componentName === 'script') {
                operations.push({
                    component: componentName,
                    status: 'error',
                    error: 'Use script tools to manage script components.'
                });
                continue;
            }

            if (componentLookup && !componentLookup.has(componentName.toLowerCase())) {
                operations.push({
                    component: componentName,
                    status: 'error',
                    error: `Component "${componentName}" is not available in this project.`
                });
                continue;
            }

            const componentPath = `components.${componentName}`;
            let hasComponent = !!entity.get(componentPath);
            const normalizedAction = typeof config.action === 'string' ? config.action.trim().toLowerCase() : null;
            const addRequested = normalizedAction === 'add' || normalizedAction === 'ensure';
            const removeRequested = normalizedAction === 'remove' || normalizedAction === 'delete';
            const result: Record<string, unknown> = {
                component: componentName
            };
            const updatedPaths: string[] = [];
            const removedPaths: string[] = [];

            if (removeRequested) {
                if (!hasComponent) {
                    result.status = 'skipped';
                    result.note = 'Component is not present on this entity.';
                    operations.push(result);
                    continue;
                }
                entity.unset(componentPath);
                result.status = 'removed';
                operations.push(result);
                continue;
            }

            if (!hasComponent && addRequested) {
                try {
                    ensureComponentExists(entity, componentName);
                    hasComponent = !!entity.get(componentPath);
                    result.added = true;
                } catch (error) {
                    result.status = 'error';
                    result.error = `Failed to add component "${componentName}": ${formatError(error)}`;
                    operations.push(result);
                    continue;
                }
            }

            if (!hasComponent) {
                result.status = 'skipped';
                result.error = 'Component is not present. Set action to "add" if you want to create it.';
                operations.push(result);
                continue;
            }

            if (typeof config.enabled === 'boolean') {
                entity.set(`${componentPath}.enabled`, config.enabled);
                updatedPaths.push(`${componentPath}.enabled`);
            }

            if (config.properties !== undefined && config.properties !== null) {
                if (!Array.isArray(config.properties)) {
                    result.status = 'error';
                    result.error = `properties for component "${componentName}" must be an array of path/value entries.`;
                    operations.push(result);
                    continue;
                }

                if (config.properties.length) {
                    const limitedProperties = config.properties.slice(0, MAX_COMPONENT_PROPERTY_UPDATES);
                    for (const entry of limitedProperties) {
                        if (!entry || typeof entry !== 'object') {
                            result.status = 'error';
                            result.error = `Each property entry for "${componentName}" must include path/value/jsonValue.`;
                            break;
                        }

                        const rawPath = typeof entry.path === 'string' ? entry.path : '';
                        const normalizedPath = normalizePropertyPath(componentName, rawPath);
                        if (!normalizedPath) {
                            result.status = 'error';
                            result.error = `Property entries for "${componentName}" require a non-empty "path".`;
                            break;
                        }

                        let value: unknown = Object.prototype.hasOwnProperty.call(entry, 'value') ? entry.value ?? null : null;
                        const rawJson = typeof entry.jsonValue === 'string' ? entry.jsonValue.trim() : '';
                        if (rawJson.length) {
                            try {
                                value = JSON.parse(rawJson);
                            } catch (error) {
                                result.status = 'error';
                                result.error = `jsonValue for "${componentName}.${normalizedPath}" is invalid JSON: ${formatError(error)}`;
                                break;
                            }
                        }

                        entity.set(`${componentPath}.${normalizedPath}`, cloneWritableValue(value));
                        updatedPaths.push(`${componentPath}.${normalizedPath}`);
                    }

                    if (result.status === 'error') {
                        operations.push(result);
                        continue;
                    }

                    if (config.properties.length > limitedProperties.length) {
                        updatedPaths.push('[truncatedComponentUpdates]');
                    }
                }
            }

            if (config.removals !== undefined && config.removals !== null) {
                if (!Array.isArray(config.removals)) {
                    result.status = 'error';
                    result.error = `removals for component "${componentName}" must be an array of strings.`;
                    operations.push(result);
                    continue;
                }

                if (config.removals.length) {
                    applyObserverRemovals(entity, componentPath, config.removals, removedPaths, MAX_DATA_REMOVALS);
                }
            }

            if (!result.status) {
                if (result.added) {
                    result.status = 'added';
                } else if (updatedPaths.length || removedPaths.length) {
                    result.status = 'updated';
                } else {
                    result.status = 'unchanged';
                }
            }

            if (updatedPaths.length) {
                result.updatedPaths = updatedPaths;
            }
            if (removedPaths.length) {
                result.removedPaths = removedPaths;
            }

            operations.push(result);
        }

        return {
            entity: buildEntitySummary(entity, true),
            operations,
            truncated: rawArgs.components.length > limitedComponents.length || undefined,
            note: rawArgs.description || null
        };
    }
};

export const createComponentTools = (): AssistantToolDefinition[] => [
    configureEntityComponentsTool
];
