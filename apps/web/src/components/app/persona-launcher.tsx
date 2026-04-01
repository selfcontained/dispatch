import { Sparkles } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";

type PersonaSummary = {
  slug: string;
  name: string;
  description: string;
};

export function PersonaLauncher({
  agent,
  sendTerminalInput,
}: {
  agent: Agent;
  sendTerminalInput: (data: string) => void;
}): JSX.Element | null {
  const cwd = agent.worktreePath ?? agent.cwd;

  const { data: personas = [] } = useQuery<PersonaSummary[]>({
    queryKey: ["personas", cwd],
    queryFn: async () => {
      const result = await api<{ personas: PersonaSummary[] }>(`/api/v1/personas?cwd=${encodeURIComponent(cwd)}`);
      return result.personas;
    },
  });

  if (personas.length === 0) return null;

  const launchPersona = (slug: string) => {
    const message = `Launch the "${slug}" persona on your current work. Provide a detailed context briefing covering what you built, key files changed, and any areas that need extra attention.`;
    sendTerminalInput(message + "\r");
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="gap-1.5 border border-border/60 bg-background/50 text-muted-foreground hover:text-foreground hover:bg-muted/60">
          <Sparkles className="h-3 w-3" />
          Launch Persona
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {personas.map((p) => (
          <DropdownMenuItem key={p.slug} onClick={() => launchPersona(p.slug)}>
            <div>
              <div className="text-sm">{p.name}</div>
              {p.description ? (
                <div className="text-xs text-muted-foreground">{p.description}</div>
              ) : null}
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
