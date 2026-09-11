import { usePromptInputController } from '@/components/ai-elements/prompt-input';
import { Icon } from '@/components/Icon';

/**
 * Starter tasks. Each row fills the composer rather than sending, so the
 * prompt can be edited before it runs.
 *
 * Laid out as a list of full-width rows instead of a row of chips: prompts are
 * sentences, and sentences clip in pills. The list wraps to the panel width and
 * grows downward, so nothing is ever cut off.
 */
const STARTERS = [
  'Summarize my unread emails and propose replies',
  'Flag anything urgent from the last 24 hours',
  'Find a free 30 minute slot this week and block it for focus time',
  'Create a Google Doc with a status report for this week',
  'Search YouTube for the most watched videos about AI agents',
  'Triage my inbox: archive newsletters, keep what needs a reply',
];

export function StarterSuggestions() {
  const { textInput } = usePromptInputController();

  return (
    <ul className="w-full overflow-hidden rounded-xl border border-border">
      {STARTERS.map((prompt) => (
        <li key={prompt} className="border-t border-rule first:border-t-0">
          <button
            type="button"
            onClick={() => textInput.setInput(prompt)}
            className="group flex w-full cursor-pointer items-center gap-2.5 bg-transparent px-3.5 py-2.5 text-left text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-surface-2 hover:text-foreground"
          >
            <Icon name="sparkle" size={14} className="shrink-0 text-primary/70" />
            <span className="min-w-0 flex-1">{prompt}</span>
            <Icon
              name="arrowRight"
              size={14}
              className="shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-60"
            />
          </button>
        </li>
      ))}
    </ul>
  );
}
