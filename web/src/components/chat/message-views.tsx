import type { UIMessage } from 'ai';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { Mark } from '@/components/Mark';
import { SignalChip } from '@/components/app/chips';
import { isTextPart, isToolPart, runCompleted } from './chat-parts';
import { ToolGroup, useToolGroups } from './tool-group';
import type { AgentDef } from '@/types';

/** The header every assistant (and user) message carries. */
export function MessageAuthor({ agent }: { agent: AgentDef }) {
  return (
    <div className="flex items-center gap-2 px-0.5">
      <Mark name={agent.name} color={agent.color} size="sm" />
      <span className="text-sm font-medium">{agent.name}</span>
    </div>
  );
}

/** One assistant message: author row, tool cards and the markdown reply. */
export function AssistantMessageView({ message, agent }: { message: UIMessage; agent: AgentDef }) {
  const groups = useToolGroups(message);
  const renderedTools = new Set<string>();
  const done = runCompleted(message);

  return (
    <Message from="assistant">
      <div className="flex items-center gap-2 px-0.5">
        <Mark name={agent.name} color={agent.color} size="sm" />
        <span className="text-sm font-medium">{agent.name}</span>
        {done && <SignalChip>saved to history</SignalChip>}
      </div>
      <MessageContent>
        {message.parts.map((part, index) => {
          if (isTextPart(part)) {
            return <MessageResponse key={index}>{part.text}</MessageResponse>;
          }
          if (isToolPart(part)) {
            if (renderedTools.has(part.toolCallId)) return null;
            renderedTools.add(part.toolCallId);
            const group = groups.get(part.toolCallId);
            if (group) return <ToolGroup key={part.toolCallId} parts={group} />;
          }
          return null;
        })}
      </MessageContent>
    </Message>
  );
}

/** One user message: right-aligned "You" meta and the plain text bubble. */
export function UserMessageView({ message }: { message: UIMessage }) {
  return (
    <Message from="user">
      <div className="ml-auto px-0.5 text-xs text-muted-foreground">You</div>
      <MessageContent>
        {message.parts.filter(isTextPart).map((part, index) => (
          <div key={index} className="whitespace-pre-wrap">
            {part.text}
          </div>
        ))}
      </MessageContent>
    </Message>
  );
}
