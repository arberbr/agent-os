import type { UIMessage } from 'ai';
import { Panel, PanelContent, PanelHeader, PanelTitle } from '@/components/app/panel';
import { StateRail } from '@/components/app/state';
import { Icon } from '@/components/Icon';
import { ActivityStep } from '@/components/app/activity-step';
import { plural } from '@/format';
import { stepsOf } from './chat-parts';

/**
 * Activity rail — the live trace panel. Steps stream in as data-step parts
 * on the assistant message; the rail reads the same parts the conversation
 * renders, so both views always agree.
 */
export function ActivityRail({ message, running }: { message: UIMessage | null; running: boolean }) {
  const steps = stepsOf(message);

  return (
    <Panel className="lg:min-h-0">
      <PanelHeader className="shrink-0">
        <PanelTitle>Activity</PanelTitle>
        <StateRail tone={running ? 'live' : 'idle'}>
          {steps.length > 0 ? plural(steps.length, 'step') : 'Idle'}
        </StateRail>
      </PanelHeader>
      <PanelContent flush className="lg:min-h-0 lg:flex-1">
        <div
          className="flex min-h-[440px] flex-col overflow-y-auto max-lg:max-h-none lg:h-full lg:min-h-0"
          role="log"
          aria-label="Agent activity"
        >
          {steps.length === 0 && (
            <div className="m-auto flex flex-col items-center gap-2 py-12 text-center">
              <span className="mb-3.5 flex size-11 items-center justify-center rounded-[13px] bg-surface-2 text-muted-foreground">
                <Icon name="runs" size={20} />
              </span>
              <div className="text-sm font-semibold">No activity yet</div>
              <p className="max-w-[30ch] text-xs text-mute">
                Tool calls and decisions stream here while an agent works.
              </p>
            </div>
          )}
          {steps.map((step, i) => (
            <ActivityStep key={i} step={step} />
          ))}
        </div>
      </PanelContent>
    </Panel>
  );
}
