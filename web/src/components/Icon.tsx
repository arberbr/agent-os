/**
 * Icon layer.
 *
 * Icons come from Phosphor: one family for the whole app, one weight for the
 * whole app, drawn by the library instead of by hand so shapes and optical
 * weight stay consistent. Each glyph is imported from its own module so the
 * bundle only carries the icons actually used.
 */
import type { Icon as PhosphorIcon, IconProps } from '@phosphor-icons/react';
import { ArrowClockwise } from '@phosphor-icons/react/dist/icons/ArrowClockwise';
import { ArrowDown } from '@phosphor-icons/react/dist/icons/ArrowDown';
import { ArrowDownLeft } from '@phosphor-icons/react/dist/icons/ArrowDownLeft';
import { ArrowRight } from '@phosphor-icons/react/dist/icons/ArrowRight';
import { ArrowSquareOut } from '@phosphor-icons/react/dist/icons/ArrowSquareOut';
import { Brain } from '@phosphor-icons/react/dist/icons/Brain';
import { CalendarBlank } from '@phosphor-icons/react/dist/icons/CalendarBlank';
import { CaretDown } from '@phosphor-icons/react/dist/icons/CaretDown';
import { CaretLeft } from '@phosphor-icons/react/dist/icons/CaretLeft';
import { CaretRight } from '@phosphor-icons/react/dist/icons/CaretRight';
import { Check } from '@phosphor-icons/react/dist/icons/Check';
import { CheckCircle } from '@phosphor-icons/react/dist/icons/CheckCircle';
import { Circle } from '@phosphor-icons/react/dist/icons/Circle';
import { Clock } from '@phosphor-icons/react/dist/icons/Clock';
import { Copy } from '@phosphor-icons/react/dist/icons/Copy';
import { Database } from '@phosphor-icons/react/dist/icons/Database';
import { DownloadSimple } from '@phosphor-icons/react/dist/icons/DownloadSimple';
import { EnvelopeSimple } from '@phosphor-icons/react/dist/icons/EnvelopeSimple';
import { FileText } from '@phosphor-icons/react/dist/icons/FileText';
import { FolderSimple } from '@phosphor-icons/react/dist/icons/FolderSimple';
import { Gear } from '@phosphor-icons/react/dist/icons/Gear';
import { GithubLogo } from '@phosphor-icons/react/dist/icons/GithubLogo';
import { Info } from '@phosphor-icons/react/dist/icons/Info';
import { Key } from '@phosphor-icons/react/dist/icons/Key';
import { Lightning } from '@phosphor-icons/react/dist/icons/Lightning';
import { Lock } from '@phosphor-icons/react/dist/icons/Lock';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/icons/MagnifyingGlass';
import { PaperPlaneTilt } from '@phosphor-icons/react/dist/icons/PaperPlaneTilt';
import { PencilSimple } from '@phosphor-icons/react/dist/icons/PencilSimple';
import { Play } from '@phosphor-icons/react/dist/icons/Play';
import { Plugs } from '@phosphor-icons/react/dist/icons/Plugs';
import { Plus } from '@phosphor-icons/react/dist/icons/Plus';
import { Pulse } from '@phosphor-icons/react/dist/icons/Pulse';
import { Rocket } from '@phosphor-icons/react/dist/icons/Rocket';
import { ShieldCheck } from '@phosphor-icons/react/dist/icons/ShieldCheck';
import { SignIn } from '@phosphor-icons/react/dist/icons/SignIn';
import { SignOut } from '@phosphor-icons/react/dist/icons/SignOut';
import { Sparkle } from '@phosphor-icons/react/dist/icons/Sparkle';
import { SquaresFour } from '@phosphor-icons/react/dist/icons/SquaresFour';
import { Stack } from '@phosphor-icons/react/dist/icons/Stack';
import { Stop } from '@phosphor-icons/react/dist/icons/Stop';
import { Trash } from '@phosphor-icons/react/dist/icons/Trash';
import { UserCircle } from '@phosphor-icons/react/dist/icons/UserCircle';
import { UserPlus } from '@phosphor-icons/react/dist/icons/UserPlus';
import { UsersThree } from '@phosphor-icons/react/dist/icons/UsersThree';
import { Warning } from '@phosphor-icons/react/dist/icons/Warning';
import { Wrench } from '@phosphor-icons/react/dist/icons/Wrench';
import { X } from '@phosphor-icons/react/dist/icons/X';
import { XCircle } from '@phosphor-icons/react/dist/icons/XCircle';
import { YoutubeLogo } from '@phosphor-icons/react/dist/icons/YoutubeLogo';

const GLYPHS = {
  grid: SquaresFour,
  agents: Sparkle,
  sparkle: Sparkle,
  runs: Pulse,
  integrations: Plugs,
  plug: Plugs,
  plus: Plus,
  play: Play,
  edit: PencilSimple,
  trash: Trash,
  arrowRight: ArrowRight,
  arrowDown: ArrowDown,
  chevronRight: CaretRight,
  chevronLeft: CaretLeft,
  chevronDown: CaretDown,
  check: Check,
  checkCircle: CheckCircle,
  xCircle: XCircle,
  copy: Copy,
  cornerDownLeft: ArrowDownLeft,
  clock: Clock,
  bolt: Lightning,
  mail: EnvelopeSimple,
  calendar: CalendarBlank,
  drive: FolderSimple,
  youtube: YoutubeLogo,
  github: GithubLogo,
  vercel: Rocket,
  supabase: Database,
  brain: Brain,
  wrench: Wrench,
  file: FileText,
  users: UsersThree,
  refresh: ArrowClockwise,
  alert: Warning,
  info: Info,
  external: ArrowSquareOut,
  close: X,
  search: MagnifyingGlass,
  send: PaperPlaneTilt,
  stop: Stop,
  shield: ShieldCheck,
  layers: Stack,
  dot: Circle,
  download: DownloadSimple,
  key: Key,
  gear: Gear,
  signIn: SignIn,
  signOut: SignOut,
  lock: Lock,
  user: UserCircle,
  userPlus: UserPlus,
} satisfies Record<string, PhosphorIcon>;

export type IconName = keyof typeof GLYPHS;

export function Icon({
  name,
  size = 16,
  className,
  weight = 'regular',
}: {
  name: IconName;
  size?: number;
  className?: string;
  weight?: IconProps['weight'];
}) {
  const Glyph = GLYPHS[name];
  return <Glyph size={size} weight={weight} className={className} aria-hidden="true" focusable="false" />;
}

/** Icon for a tool group / tool name prefix. */
export function toolIcon(name: string): IconName {
  if (name.startsWith('gmail')) return 'mail';
  if (name.startsWith('calendar')) return 'calendar';
  if (name.startsWith('drive')) return 'drive';
  if (name.startsWith('youtube')) return 'youtube';
  if (name.startsWith('github')) return 'github';
  if (name.startsWith('vercel')) return 'vercel';
  if (name.startsWith('supabase')) return 'supabase';
  if (name === 'delegate') return 'users';
  if (name.startsWith('memory')) return 'brain';
  return 'wrench';
}
