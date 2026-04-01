import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";

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
  const [personas, setPersonas] = useState<PersonaSummary[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const cwd = agent.worktreePath ?? agent.cwd;
    api<{ personas: PersonaSummary[] }>(`/api/v1/personas?cwd=${encodeURIComponent(cwd)}`)
      .then((data) => {
        setPersonas(data.personas);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [agent.cwd, agent.worktreePath]);

  if (!loaded || personas.length === 0) return null;

  const launchPersona = (slug: string) => {
    const message = `Launch the "${slug}" persona on your current work. Provide a detailed context briefing covering what you built, key files changed, and any areas that need extra attention.`;
    sendTerminalInput(message + "\r");
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-6 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground">
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
