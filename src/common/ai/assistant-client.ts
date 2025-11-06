import OpenAI from 'openai';
import type {
    FunctionTool,
    Response,
    ResponseFunctionToolCall,
    ResponseInputItem,
    ResponseReasoningItem
} from 'openai/resources/responses/responses';

type AssistantRole = 'system' | 'developer' | 'user' | 'assistant';

type AssistantMessage = {
    role: AssistantRole;
    content: string;
    type?: 'message';
};

type AssistantConversationItem = AssistantMessage | ResponseInputItem.FunctionCallOutput | ResponseFunctionToolCall | ResponseReasoningItem;
type AssistantRequestItem = AssistantMessage | ResponseInputItem.FunctionCallOutput | ResponseFunctionToolCall | ResponseReasoningItem;

export type AssistantToolResult = string | number | boolean | null | Record<string, unknown> | Array<unknown>;

export type AssistantToolHandler<TArgs = Record<string, unknown>> = (args: TArgs) => AssistantToolResult | Promise<AssistantToolResult>;

export type AssistantToolDefinition<TArgs = Record<string, unknown>> = {
    name: string;
    description: string;
    parameters?: Record<string, unknown> | null;
    strict?: boolean;
    handler: AssistantToolHandler<TArgs>;
};

export type AssistantClientOptions = {
    apiKey?: string | (() => Promise<string> | string);
    baseUrl?: string;
    model?: string;
    instructions?: string;
    organization?: string;
    project?: string;
    headers?: Record<string, string | undefined>;
    tools?: AssistantToolDefinition[];
    parallelToolCalls?: boolean;
    maxToolIterations?: number;
};

export type AssistantSendOptions = {
    signal?: AbortSignal;
};

export type AssistantResult = {
    text: string;
    response: Response;
};

const DEFAULT_MODEL = 'gpt-5';
const DEFAULT_MAX_TOOL_ITERATIONS = 60;
const DEFAULT_TOOL_PARAMETERS = {
    type: 'object',
    properties: {},
    additionalProperties: false
};
const RESPONSES_BETA_HEADER = 'responses=v1';

const envString = (raw?: string | null): string | undefined => {
    if (!raw) {
        return undefined;
    }
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const ENV_FALLBACKS: AssistantClientOptions = {
    apiKey: envString(process.env.OPENAI_API_KEY),
    baseUrl: envString(process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || process.env.OPENAI_ENDPOINT),
    model: envString(process.env.OPENAI_MODEL),
    instructions: envString(process.env.OPENAI_ASSISTANT_INSTRUCTIONS),
    organization: envString(process.env.OPENAI_ORG || process.env.OPENAI_ORGANIZATION),
    project: envString(process.env.OPENAI_PROJECT),
    headers: undefined,
    tools: undefined,
    parallelToolCalls: undefined,
    maxToolIterations: undefined
};

export class AssistantClient {
    private openai: OpenAI | null;
    private readonly options: AssistantClientOptions & { model: string; headers: Record<string, string | undefined> };
    private conversation: AssistantConversationItem[] = [];
    private requestHistory: AssistantRequestItem[] = [];
    private readonly toolMap: Map<string, AssistantToolDefinition>;
    private readonly functionTools?: FunctionTool[];
    private readonly maxToolIterations: number;
    private readonly parallelToolCalls: boolean;

    constructor(options: AssistantClientOptions = {}) {
        const resolvedOptions: AssistantClientOptions = {
            ...ENV_FALLBACKS,
            ...options
        };

        const mergedHeaders = {
            'OpenAI-Beta': RESPONSES_BETA_HEADER,
            ...(resolvedOptions.headers || {})
        };

        this.options = {
            ...resolvedOptions,
            model: resolvedOptions.model || DEFAULT_MODEL,
            headers: mergedHeaders
        };
        this.toolMap = new Map((resolvedOptions.tools || []).map((tool) => [tool.name, tool]));
        this.functionTools = this.toolMap.size ? Array.from(this.toolMap.values()).map((tool): FunctionTool => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters ?? DEFAULT_TOOL_PARAMETERS,
            strict: tool.strict ?? true
        })) : undefined;
        this.maxToolIterations = resolvedOptions.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
        this.parallelToolCalls = resolvedOptions.parallelToolCalls ?? false;

        if (this.options.instructions) {
            const systemMessage: AssistantMessage = {
                role: 'system',
                content: this.options.instructions,
                type: 'message'
            };
            this.conversation.push(systemMessage);
            this.requestHistory.push(systemMessage);
        }

        this.openai = this.createClient();
    }

    private createClient(): OpenAI | null {
        if (!this.options.apiKey) {
            return null;
        }

        try {
            const headers = Object.fromEntries(
                Object.entries(this.options.headers || {}).filter(([, value]) => value !== undefined && value !== null)
            );

            return new OpenAI({
                apiKey: this.options.apiKey,
                baseURL: this.options.baseUrl,
                organization: this.options.organization ?? null,
                project: this.options.project ?? null,
                defaultHeaders: headers,
                dangerouslyAllowBrowser: true
            });
        } catch (err) {
            console.warn('Failed to initialize OpenAI client for assistant', err);
            return null;
        }
    }

    isReady(): boolean {
        return !!this.openai;
    }

    resetConversation() {
        this.conversation = [];
        this.requestHistory = [];
        if (this.options.instructions) {
            const systemMessage: AssistantMessage = {
                role: 'system',
                content: this.options.instructions,
                type: 'message'
            };
            this.conversation.push(systemMessage);
            this.requestHistory.push(systemMessage);
        }
    }

    async send(text: string, options?: AssistantSendOptions): Promise<AssistantResult> {
        if (!this.openai) {
            throw new Error('Assistant backend is not configured.');
        }

        const userMessage: AssistantMessage = {
            role: 'user',
            content: text,
            type: 'message'
        };
        const conversationStartIndex = this.conversation.length;
        const requestStartIndex = this.requestHistory.length;
        this.conversation.push(userMessage);
        this.requestHistory.push(userMessage);

        try {
            let iteration = 0;

            while (true) {
                const response = await this.openai.responses.create({
                    model: this.options.model,
                    input: this.requestHistory,
                    ...(this.functionTools ? {
                        tools: this.functionTools,
                        parallel_tool_calls: this.parallelToolCalls
                    } : {})
                }, {
                    signal: options?.signal
                });

                const { reasoningItems, toolCalls } = AssistantClient.collectResponseArtifacts(response);
                if (reasoningItems.length) {
                    this.conversation.push(...reasoningItems);
                    if (toolCalls.length) {
                        this.requestHistory.push(...reasoningItems);
                    }
                }

                if (!toolCalls.length) {
                    const assistantText = AssistantClient.extractText(response);
                    const assistantMessage: AssistantMessage = {
                        role: 'assistant',
                        content: assistantText,
                        type: 'message'
                    };
                    this.conversation.push(assistantMessage);
                    this.requestHistory.push(assistantMessage);

                    return {
                        text: assistantText,
                        response
                    };
                }

                if (!this.functionTools?.length) {
                    throw new Error('Assistant requested an editor tool, but none are registered.');
                }

                if (iteration >= this.maxToolIterations) {
                    throw new Error(`Assistant exceeded the tool-call limit (${this.maxToolIterations}).`);
                }
                iteration++;

                for (const call of toolCalls) {
                    this.conversation.push(call);
                    this.requestHistory.push(call);
                    const output = await this.invokeTool(call);
                    this.conversation.push(output);
                    this.requestHistory.push(output);
                }
            }
        } catch (error) {
            this.conversation.splice(conversationStartIndex);
            this.requestHistory.splice(requestStartIndex);
            throw error;
        }
    }

    private async invokeTool(call: ResponseFunctionToolCall): Promise<ResponseInputItem.FunctionCallOutput> {
        const tool = this.toolMap.get(call.name);
        const callId = call.call_id || call.id;

        if (!callId) {
            throw new Error(`Tool call "${call.name}" did not include a call id.`);
        }

        if (!tool) {
            return AssistantClient.createToolOutput(callId, `Tool "${call.name}" is not available in this editor build.`);
        }

        let parsedArguments: unknown = {};
        if (call.arguments && call.arguments.trim().length) {
            try {
                parsedArguments = JSON.parse(call.arguments);
            } catch (error) {
                return AssistantClient.createToolOutput(callId, `Unable to parse arguments for "${call.name}": ${AssistantClient.formatError(error)}.`);
            }
        }

        try {
            const result = await tool.handler(parsedArguments as Record<string, unknown>);
            return AssistantClient.createToolOutput(callId, this.serializeToolResult(result));
        } catch (error) {
            return AssistantClient.createToolOutput(callId, `Tool "${call.name}" failed: ${AssistantClient.formatError(error)}`);
        }
    }

    private serializeToolResult(value: AssistantToolResult): string {
        if (value === undefined || value === null) {
            return 'null';
        }

        if (typeof value === 'string') {
            return value;
        }

        if (typeof value === 'number' || typeof value === 'boolean') {
            return JSON.stringify(value);
        }

        try {
            return JSON.stringify(value, null, 2);
        } catch (error) {
            return `Unable to serialize tool result: ${AssistantClient.formatError(error)}`;
        }
    }

    private static collectResponseArtifacts(response: Response) {
        const reasoningItems: ResponseReasoningItem[] = [];
        const toolCalls: ResponseFunctionToolCall[] = [];

        if (Array.isArray(response.output)) {
            for (const item of response.output) {
                if (item.type === 'reasoning') {
                    reasoningItems.push(item);
                } else if (item.type === 'function_call') {
                    toolCalls.push(item);
                }
            }
        }

        return { reasoningItems, toolCalls };
    }

    private static extractText(response: Response): string {
        if (response.output_text) {
            return response.output_text.trim();
        }

        const segments: string[] = [];
        if (Array.isArray(response.output)) {
            for (const item of response.output) {
                if (item.type !== 'message') {
                    continue;
                }

                for (const content of item.content) {
                    if (content.type === 'output_text' && typeof content.text === 'string') {
                        segments.push(content.text);
                    }
                }
            }
        }
        return segments.join('').trim();
    }

    private static createToolOutput(callId: string, output: string): ResponseInputItem.FunctionCallOutput {
        return {
            type: 'function_call_output',
            call_id: callId,
            output
        };
    }

    private static formatError(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }
        if (typeof error === 'string' && error.trim().length) {
            return error.trim();
        }
        return 'Unknown error';
    }
}
