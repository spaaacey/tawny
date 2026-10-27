import { InfoIcon, SearchIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './components/ui/alert-dialog';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Checkbox } from './components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './components/ui/collapsible';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './components/ui/command';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu';
import { Input } from './components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from './components/ui/input-group';
import { Kbd, KbdGroup } from './components/ui/kbd';
import { Label } from './components/ui/label';
import { ScrollArea } from './components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select';
import { Separator } from './components/ui/separator';
import { Toaster } from './components/ui/sonner';
import { Spinner } from './components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { Textarea } from './components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/ui/tooltip';
import { theme } from './lib/theme';

const BUTTON_VARIANTS = ['default', 'secondary', 'outline', 'ghost', 'destructive', 'link'] as const;
const BUTTON_SIZES = ['xs', 'sm', 'default', 'lg'] as const;
const BADGE_VARIANTS = ['default', 'secondary', 'outline', 'ghost', 'destructive', 'link'] as const;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section id={title.toLowerCase().replace(/\W+/g, '-')} className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">{title}</h2>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border p-4">{children}</div>
    </section>
  );
}

/** Dev-only component gallery: open the dev app at `#gallery`. Add new primitives here as sections. */
export function Gallery() {
  return (
    <TooltipProvider>
      <div className="h-screen overflow-y-auto bg-background text-foreground">
        <div className="mx-auto flex max-w-4xl flex-col gap-8 p-8">
          <header className="flex items-center justify-between">
            <h1 className="text-xl font-semibold">Component gallery</h1>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                location.hash = '';
                location.reload();
              }}
            >
              Back to app
            </Button>
            <Button variant="outline" size="sm" onClick={() => theme.sync(theme.name === 'mocha' ? 'latte' : 'mocha')}>
              Toggle theme
            </Button>
          </header>

          <Section title="Button">
            {BUTTON_VARIANTS.map((v) => (
              <div key={v} className="flex w-full items-center gap-3">
                <span className="w-24 text-xs text-muted-foreground">{v}</span>
                {BUTTON_SIZES.map((s) => (
                  <Button key={s} variant={v} size={s}>
                    {s}
                  </Button>
                ))}
                <Button variant={v} disabled>
                  disabled
                </Button>
              </div>
            ))}
          </Section>

          <Section title="Badge">
            {BADGE_VARIANTS.map((v) => (
              <Badge key={v} variant={v}>
                {v}
              </Badge>
            ))}
          </Section>

          <Section title="Form">
            <div className="grid w-full grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="g-input">Input</Label>
                <Input id="g-input" placeholder="Placeholder" />
                <Input defaultValue="Disabled" disabled />
                <Input aria-invalid defaultValue="Invalid" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="g-textarea">Textarea</Label>
                <Textarea id="g-textarea" placeholder="Type here" />
                <div className="flex items-center gap-2">
                  <Checkbox id="g-check" defaultChecked />
                  <Label htmlFor="g-check">Checked</Label>
                  <Checkbox id="g-check2" />
                  <Label htmlFor="g-check2">Unchecked</Label>
                  <Checkbox disabled />
                </div>
              </div>
              <Select defaultValue="a">
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="a">Option A</SelectItem>
                  <SelectItem value="b">Option B</SelectItem>
                  <SelectItem value="c">Option C</SelectItem>
                </SelectContent>
              </Select>
              <InputGroup>
                <InputGroupAddon>
                  <SearchIcon />
                </InputGroupAddon>
                <InputGroupInput placeholder="Search…" />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton>Go</InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </div>
          </Section>

          <Section title="Misc">
            <Kbd>⌘</Kbd>
            <KbdGroup>
              <Kbd>ctrl</Kbd>
              <Kbd>shift</Kbd>
              <Kbd>g</Kbd>
            </KbdGroup>
            <Spinner />
            <Separator orientation="vertical" className="h-6" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon">
                  <InfoIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Tooltip text</TooltipContent>
            </Tooltip>
            <Button variant="outline" onClick={() => toast('Hello', { description: 'A toast' })}>
              Toast
            </Button>
          </Section>

          <Section title="Tabs">
            <Tabs defaultValue="one" className="w-full">
              <TabsList>
                <TabsTrigger value="one">One</TabsTrigger>
                <TabsTrigger value="two">Two</TabsTrigger>
              </TabsList>
              <TabsContent value="one">First panel</TabsContent>
              <TabsContent value="two">Second panel</TabsContent>
            </Tabs>
          </Section>

          <Section title="Collapsible / ScrollArea">
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button variant="outline">Toggle</Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2 text-sm">Hidden content</CollapsibleContent>
            </Collapsible>
            <ScrollArea className="h-24 w-48 rounded-md border p-2">
              {Array.from({ length: 20 }, (_, i) => (
                <div key={i} className="text-sm">
                  Row {i + 1}
                </div>
              ))}
            </ScrollArea>
          </Section>

          <Section title="Overlays">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">Dialog</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Dialog title</DialogTitle>
                  <DialogDescription>Dialog description.</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button>Save</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive">Alert dialog</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Are you sure?</AlertDialogTitle>
                  <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction>Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">Dropdown</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuLabel>Label</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem>Item one</DropdownMenuItem>
                <DropdownMenuItem variant="destructive">Destructive</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <ContextMenu>
              <ContextMenuTrigger className="rounded-md border border-dashed px-4 py-3 text-sm">
                Right-click me
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem>Copy</ContextMenuItem>
                <ContextMenuItem>Paste</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </Section>

          <Section title="Command">
            <Command className="w-full max-w-sm rounded-lg border">
              <CommandInput placeholder="Type a command…" />
              <CommandList>
                <CommandEmpty>No results.</CommandEmpty>
                <CommandGroup heading="Suggestions">
                  <CommandItem>Open file</CommandItem>
                  <CommandItem>New worktree</CommandItem>
                  <CommandItem>Toggle sidebar</CommandItem>
                </CommandGroup>
              </CommandList>
            </Command>
          </Section>
        </div>
      </div>
      <Toaster />
    </TooltipProvider>
  );
}
