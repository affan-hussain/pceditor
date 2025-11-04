import { Panel, Container, TextInput, Button } from '@playcanvas/pcui';

import { AssistantClient } from '../../common/ai/assistant-client.ts';

type MessageRole = 'user' | 'assistant';

type MessageHandle = {
    wrapper: HTMLDivElement;
    body: HTMLDivElement;
};

const DEFAULT_ASSISTANT_INSTRUCTIONS = 'You are the PlayCanvas Editor assistant. Provide concise, actionable answers grounded in the current project context. Ask clarifying questions before attempting risky edits.';

editor.once('load', () => {
    const viewport = editor.call('layout.viewport');
    const assetPanel = editor.call('layout.assets');
    const assistantClient = new AssistantClient({
        instructions: DEFAULT_ASSISTANT_INSTRUCTIONS
    });
    const assistantReady = assistantClient.isReady();

    const assistantPanel = new Panel({
        class: 'assistant-panel',
        collapsed: true,
        collapsible: true,
        headerText: 'AI ASSISTANT',
        hidden: !editor.call('permissions:read') || editor.call('viewport:expand:state')
    });
    viewport.append(assistantPanel);

    const adjustPosition = () => {
        assistantPanel.style.bottom = assetPanel.collapsed ? '36px' : '4px';
    };

    adjustPosition();
    assetPanel.on('collapse', adjustPosition);
    assetPanel.on('expand', adjustPosition);

    editor.on('permissions:set', (level) => {
        assistantPanel.hidden = !level || editor.call('viewport:expand:state');
    });

    editor.on('viewport:expand', (state) => {
        assistantPanel.hidden = state;
    });

    assistantPanel.element.addEventListener('mouseover', () => {
        editor.emit('viewport:hover', false);
    }, false);

    editor.method('assistant:panel', () => assistantPanel);

    const container = new Container({
        class: 'assistant-panel__body'
    });

    assistantPanel.append(container);

    const messages = new Container({
        class: 'assistant-panel__messages'
    });
    container.append(messages);

    const inputRow = new Container({
        class: 'assistant-panel__input-row'
    });
    container.append(inputRow);

    const messageInput = new TextInput({
        keyChange: true,
        blurOnEnter: false,
        placeholder: 'Describe what you need help with...'
    });
    messageInput.class.add('assistant-panel__input');
    inputRow.append(messageInput);

    const sendButton = new Button({
        text: 'Send',
        class: 'assistant-panel__send'
    });
    inputRow.append(sendButton);

    const addMessage = (role: MessageRole, text: string): MessageHandle => {
        const wrapper = document.createElement('div');
        wrapper.classList.add('assistant-panel__message', `assistant-panel__message--${role}`);

        const label = document.createElement('div');
        label.classList.add('assistant-panel__message-label');
        label.textContent = role === 'user' ? 'You' : 'Assistant';
        wrapper.appendChild(label);

        const body = document.createElement('div');
        body.classList.add('assistant-panel__message-text');
        body.textContent = text;
        wrapper.appendChild(body);

        messages.append(wrapper);
        messages.element.scrollTop = messages.element.scrollHeight;

        return { wrapper, body };
    };

    const formatError = (error: unknown) => {
        if (error instanceof Error) {
            return error.message;
        }
        if (typeof error === 'string' && error.trim().length) {
            return error;
        }
        return 'Unknown error';
    };

    const setSendingState = (sending: boolean) => {
        sendButton.enabled = assistantReady && !sending;
        messageInput.readOnly = sending;
    };

    let isSending = false;

    const sendMessage = async () => {
        if (!assistantReady || isSending) {
            return;
        }

        const value = (messageInput.value || '').trim();
        if (!value) {
            return;
        }

        addMessage('user', value);
        messageInput.value = '';
        isSending = true;
        setSendingState(true);

        const assistantMessage = addMessage('assistant', 'Thinking...');

        try {
            const result = await assistantClient.send(value);
            assistantMessage.body.textContent = result.text || 'The assistant returned an empty reply.';
        } catch (error) {
            assistantMessage.body.textContent = `Unable to contact the assistant: ${formatError(error)}`;
            assistantMessage.wrapper.classList.add('assistant-panel__message--error');
        } finally {
            isSending = false;
            setSendingState(false);
        }
    };

    sendButton.on('click', sendMessage);

    messageInput.element.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void sendMessage();
        }
    });

    assistantPanel.on('expand', () => {
        setTimeout(() => {
            messageInput.focus(true);
        }, 200);
    });

    editor.method('assistant:sendMessage', sendMessage);

    if (assistantReady) {
        addMessage('assistant', 'Hi! I\'m the PlayCanvas assistant. Let me know what you need help with and I\'ll reason over your project.');
    } else {
        sendButton.enabled = false;
        messageInput.readOnly = true;
        addMessage('assistant', 'Assistant backend is not configured. Set OPENAI_* environment variables (e.g. OPENAI_API_KEY) before building to enable this panel.');
    }
});
