import { Panel, Container, TextInput, Button } from '@playcanvas/pcui';

type MessageRole = 'user' | 'assistant';

editor.once('load', () => {
    const viewport = editor.call('layout.viewport');
    const assetPanel = editor.call('layout.assets');

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

    const addMessage = (role: MessageRole, text: string) => {
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
    };

    const cannedResponses = [
        'Thanks for testing the upcoming assistant! This is a placeholder reply until the OpenAI-powered workflow is wired up.',
        'Once the AI backend is connected this panel will summarize context, plan changes, and ask for approval before editing your project.',
        'Everything you type here is kept local for now, which makes it a safe sandbox for iterating on the UX.'
    ];
    let cannedIndex = 0;

    const scheduleResponse = (userMessage: string) => {
        const response = `${cannedResponses[cannedIndex % cannedResponses.length]}\n\nEchoing back what you said so you can see the flow:\n"${userMessage}"`;
        cannedIndex += 1;

        setTimeout(() => {
            addMessage('assistant', response);
        }, 400);
    };

    const sendMessage = () => {
        const value = (messageInput.value || '').trim();
        if (!value) {
            return;
        }

        addMessage('user', value);
        messageInput.value = '';
        scheduleResponse(value);
    };

    sendButton.on('click', sendMessage);

    messageInput.element.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    });

    assistantPanel.on('expand', () => {
        setTimeout(() => {
            messageInput.focus(true);
        }, 200);
    });

    editor.method('assistant:sendMessage', sendMessage);

    addMessage('assistant', 'Hi! I\'m the upcoming PlayCanvas assistant. For now I can echo your messages and show how the conversation UI will behave.');
});
