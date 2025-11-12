import type { AssistantToolDefinition } from '../../../common/ai/assistant-client.ts';
import {
    PLAYCANVAS_SCRIPTING_REFERENCE_METADATA,
    PLAYCANVAS_SCRIPTING_REFERENCE_SECTIONS,
    getPlayCanvasReferenceMarkdown
} from '../reference/playcanvas-scripting-reference.ts';

type ReferenceToolArgs = {
    sectionId?: string | null;
};

export const createReferenceTools = (): AssistantToolDefinition<ReferenceToolArgs>[] => {
    const sectionSummaries = PLAYCANVAS_SCRIPTING_REFERENCE_SECTIONS.map((section) => ({
        id: section.id,
        title: section.title,
        summary: section.summary
    }));

    const referenceTool: AssistantToolDefinition<ReferenceToolArgs> = {
        name: 'get_playcanvas_scripting_reference',
        description: 'Returns curated PlayCanvas scripting guidance (ESM scripts, lifecycle/events, script attributes, engine API, events). Provide a section id to narrow the response or null to fetch everything.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                sectionId: {
                    type: ['string', 'null'],
                    description: `Optional section id (${sectionSummaries.map((section) => section.id).join(', ')}) to limit the response.`
                }
            },
            required: ['sectionId']
        },
        handler: (rawArgs) => {
            const sectionIdArg = rawArgs?.sectionId;
            const sectionId = typeof sectionIdArg === 'string' ? sectionIdArg.trim() : '';
            if (sectionId && !PLAYCANVAS_SCRIPTING_REFERENCE_SECTIONS.some((section) => section.id === sectionId)) {
                throw new Error(`Unknown PlayCanvas reference section "${sectionId}". Available ids: ${sectionSummaries.map((section) => section.id).join(', ')}`);
            }

            return {
                metadata: PLAYCANVAS_SCRIPTING_REFERENCE_METADATA,
                sectionId: sectionId || null,
                availableSections: sectionSummaries,
                markdown: getPlayCanvasReferenceMarkdown(sectionId || null)
            };
        }
    };

    return [referenceTool];
};
