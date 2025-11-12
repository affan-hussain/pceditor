import type { Observer } from '@playcanvas/observer';

import {
    DEFAULT_ASSET_USAGE_LIMIT,
    MAX_MATERIAL_UPDATES,
    MAX_DATA_REMOVALS,
    clampNumber,
    buildEntitySummary,
    buildAssetSummary,
    getAssetsUsedIndex,
    getReferenceType,
    parseIdValue,
    applyObserverRemovals,
    cloneWritableValue
} from './tool-common.ts';
import type { AssistantToolDefinition } from '../../../common/ai/assistant-client.ts';

type ScriptUsageLike = {
    assetId: number;
};

type MaterialUpdateEntry = {
    path: string;
    value?: string | number | boolean | null;
    jsonValue?: string | null;
};

type UpdateMaterialArgs = {
    assetId: number;
    data?: MaterialUpdateEntry[] | null;
    removals?: string[] | null;
    description?: string | null;
};

const describeAssetUsageTool: AssistantToolDefinition<ScriptUsageLike> = {
    name: 'describe_asset_usage',
    description: 'Lists where an asset is referenced (entities, other assets, scene settings) to help the assistant understand dependencies.',
    parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['assetId', 'maxReferences', 'includeDetails'],
        properties: {
            assetId: {
                type: 'number',
                description: 'ID of the asset to inspect.'
            },
            maxReferences: {
                type: ['number', 'null'],
                description: 'Maximum number of referencing objects to list (default 10, max 20).'
            },
            includeDetails: {
                type: ['boolean', 'null'],
                description: 'Include component details when referencing entities are summarized.'
            }
        }
    },
    handler: (rawArgs) => {
        const assetId = typeof rawArgs?.assetId === 'number' ? rawArgs.assetId : null;
        if (assetId === null) {
            return {
                error: 'assetId is required.'
            };
        }

        const index = getAssetsUsedIndex();
        const usage = index ? index[assetId] || index[String(assetId)] : null;
        const asset = editor.call('assets:get', assetId) as Observer | null;
        const summary = asset ? buildAssetSummary(asset) : { id: assetId, missing: true };

        if (!usage) {
            return {
                asset: summary,
                usageCount: 0,
                references: [],
                message: 'Asset is not referenced by any entities or other assets.'
            };
        }

        const includeDetails = typeof rawArgs.includeDetails === 'boolean' ? rawArgs.includeDetails : false;
        const maxReferences = clampNumber(rawArgs.maxReferences, DEFAULT_ASSET_USAGE_LIMIT);
        const references: Record<string, unknown>[] = [];
        let overflow = 0;

        for (const [refId, refEntry] of Object.entries(usage.ref || {})) {
            if (references.length >= maxReferences) {
                overflow++;
                continue;
            }

            const type = getReferenceType(refEntry) || 'asset';
            const parsedId = parseIdValue(refId);

            if (type === 'entity') {
                const entity = editor.call('entities:get', parsedId) as Observer | null;
                references.push({
                    type,
                    entity: entity ? buildEntitySummary(entity, includeDetails) : { id: parsedId, missing: true }
                });
                continue;
            }

            if (type === 'asset') {
                const refAssetId = typeof parsedId === 'number' ? parsedId : Number(parsedId);
                const refAsset = Number.isNaN(refAssetId) ? null : editor.call('assets:get', refAssetId) as Observer | null;
                references.push({
                    type,
                    asset: refAsset ? buildAssetSummary(refAsset) : { id: parsedId, missing: true }
                });
                continue;
            }

            references.push({
                type,
                id: parsedId
            });
        }

        return {
            asset: summary,
            usageCount: Object.keys(usage.ref || {}).length,
            activeParents: usage.parent,
            references,
            truncated: overflow > 0 || undefined,
            moreReferences: overflow || undefined
        };
    }
};

const updateMaterialAssetTool: AssistantToolDefinition<UpdateMaterialArgs> = {
    name: 'update_material_asset',
    description: 'Modifies fields on a material asset (asset.data.*) so the assistant can tweak colors, textures, and other properties.',
    parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['assetId', 'data', 'removals', 'description'],
        properties: {
            assetId: {
                type: 'number',
                description: 'ID of the material asset to update.'
            },
            data: {
                type: ['array', 'null'],
                description: 'List of material property updates. Each entry targets a dot-separated path under asset.data (e.g. "diffuse.r").',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['path', 'value', 'jsonValue'],
                    properties: {
                        path: {
                            type: 'string',
                            description: 'Property name or dot path inside asset.data.'
                        },
                        value: {
                            type: ['string', 'number', 'boolean', 'null'],
                            description: 'Primitive value assigned to the path when jsonValue is omitted.'
                        },
                        jsonValue: {
                            type: ['string', 'null'],
                            description: 'Optional JSON string for complex values; overrides the primitive value when present.'
                        }
                    }
                }
            },
            removals: {
                type: ['array', 'null'],
                description: 'List of dot-paths (relative to asset.data) to delete.',
                items: {
                    type: 'string'
                }
            },
            description: {
                type: ['string', 'null'],
                description: 'Optional note describing why the change was made.'
            }
        }
    },
    handler: (rawArgs) => {
        if (!editor.call('permissions:write')) {
            return {
                error: 'Write permission is required to modify material assets.'
            };
        }

        if (typeof rawArgs?.assetId !== 'number') {
            return {
                error: 'assetId is required.'
            };
        }

        const asset = editor.call('assets:get', rawArgs.assetId) as Observer | null;
        if (!asset) {
            return {
                error: `No asset found with id ${rawArgs.assetId}.`
            };
        }

        if (asset.get('type') !== 'material') {
            return {
                error: `Asset ${rawArgs.assetId} is a "${asset.get('type')}" asset, not a material.`
            };
        }

        if (rawArgs.data !== null && rawArgs.data !== undefined && !Array.isArray(rawArgs.data)) {
            return {
                error: 'data must be an array of update entries.'
            };
        }

        if (rawArgs.removals !== null && rawArgs.removals !== undefined && !Array.isArray(rawArgs.removals)) {
            return {
                error: 'removals must be an array of path strings.'
            };
        }

        const updatedPaths: string[] = [];
        const removedPaths: string[] = [];

        if (Array.isArray(rawArgs.data) && rawArgs.data.length) {
            const limitedUpdates = rawArgs.data.slice(0, MAX_MATERIAL_UPDATES);
            for (const update of limitedUpdates) {
                if (!update || typeof update !== 'object') {
                    return {
                        error: 'Each entry in data must be an object with path/value/jsonValue.'
                    };
                }

                const path = typeof update.path === 'string' ? update.path.trim() : '';
                if (!path) {
                    return {
                        error: 'Each data entry requires a non-empty "path".'
                    };
                }

                let value: unknown = Object.prototype.hasOwnProperty.call(update, 'value') ? update.value ?? null : null;
                const rawJson = typeof update.jsonValue === 'string' ? update.jsonValue.trim() : '';
                if (rawJson.length) {
                    try {
                        value = JSON.parse(rawJson);
                    } catch (error) {
                        return {
                            error: `jsonValue for material path "${path}" is invalid JSON: ${error instanceof Error ? error.message : String(error)}`
                        };
                    }
                }

                asset.set(`data.${path}`, cloneWritableValue(value));
                updatedPaths.push(`data.${path}`);
            }

            if (rawArgs.data.length > limitedUpdates.length) {
                updatedPaths.push('[truncatedMaterialUpdates]');
            }
        }

        if (Array.isArray(rawArgs.removals)) {
            applyObserverRemovals(asset, 'data', rawArgs.removals, removedPaths, MAX_DATA_REMOVALS);
        }

        if (!updatedPaths.length && !removedPaths.length) {
            return {
                asset: buildAssetSummary(asset),
                note: rawArgs.description || null,
                message: 'No changes were applied. Provide a "data" object or "removals" array to modify the asset.'
            };
        }

        return {
            asset: buildAssetSummary(asset),
            updatedPaths: updatedPaths.length ? updatedPaths : undefined,
            removedPaths: removedPaths.length ? removedPaths : undefined,
            note: rawArgs.description || null
        };
    }
};

export const createAssetTools = (): AssistantToolDefinition[] => [
    describeAssetUsageTool,
    updateMaterialAssetTool
];
