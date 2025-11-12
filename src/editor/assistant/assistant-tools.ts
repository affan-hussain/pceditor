import { createAssetTools } from './tools/asset-tools.ts';
import { createComponentTools } from './tools/component-tools.ts';
import { createDescribeTools } from './tools/describe-tools.ts';
import { createReferenceTools } from './tools/reference-tools.ts';
import { createScriptTools } from './tools/script-tools.ts';
import type { AssistantToolDefinition } from '../../common/ai/assistant-client.ts';

export const createAssistantTools = (): AssistantToolDefinition[] => [
    ...createReferenceTools(),
    ...createDescribeTools(),
    ...createComponentTools(),
    ...createScriptTools(),
    ...createAssetTools()
];
