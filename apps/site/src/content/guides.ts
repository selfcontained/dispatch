export const guides = [
  {
    id: "agents",
    label: "Work with agents",
    title: "Start an agent",
    color: "green",
    desc: "Launch, guide and return to an agent’s work.",
    intro:
      "An agent works in a folder you choose. Its stream keeps the conversation and shared evidence together.",
    needs:
      "A signed-in coding-agent CLI and an existing project folder. The assignment can be research, writing, coding or other work your agent supports.",
    steps: [
      [
        "Choose the workspace",
        "Use Create to pick a project or folder. Choose the agent type and review its access settings.",
      ],
      [
        "Give it a focused assignment",
        "Describe the outcome and attach the context it needs. For Git projects, use a managed worktree when the change needs a separate checkout.",
      ],
      [
        "Guide it through the stream",
        "Read replies, answer questions and open shared files or links. Add direction when the work needs to change.",
      ],
      [
        "Return to the same work",
        "Reopen the agent to continue the conversation. Closing the browser does not itself stop the agent; the host still needs to stay available.",
      ],
    ],
    result:
      "You can see the agent’s result and the evidence behind it, or an explicit question or error to act on.",
    next: "tasks",
  },
  {
    id: "tasks",
    label: "Organize project work",
    title: "Track work on a project board",
    color: "green",
    badge: "Preview",
    desc: "Keep tasks, stages and assigned agents in view.",
    intro:
      "A project board holds the work while agents come and go. Each task has its own conversation and assignment history.",
    needs: "A Preview release with task boards and a project folder.",
    steps: [
      [
        "Create the task",
        "Write the desired outcome and useful context. Choose the column that reflects where the work stands.",
      ],
      [
        "Assign or launch an agent",
        "Start an agent for the task, or assign an existing one. The card connects the work to its agent.",
      ],
      [
        "Move work deliberately",
        "Use the board as work moves from ready to in progress, review and done. A move is not proof that an agent finished successfully.",
      ],
      [
        "Keep the handoff with the task",
        "Use its conversation and links for evidence, decisions and the next step. Review the result before marking it done.",
      ],
    ],
    result:
      "A board that shows what needs doing, who is working on it and what is ready for a decision.",
    next: "workflows",
  },
  {
    id: "workflows",
    label: "Build your workflow",
    title: "Make a task stage launch an agent",
    color: "green",
    badge: "Preview",
    desc: "Use templates, column triggers and scheduled jobs.",
    intro:
      "A column trigger can launch a saved template when a task enters that column. Keep the pattern small enough to inspect.",
    needs:
      "A task board and a launch template. Task-board triggers are in Preview; templates and scheduled jobs are also available in Stable.",
    steps: [
      [
        "Save the launch as a template",
        "Choose the agent type, starting instructions and relevant launch options.",
      ],
      [
        "Configure a column trigger",
        "Open the column menu and choose the template to launch when work enters it.",
      ],
      [
        "Move one task through it",
        "Check the launched agent and its outcome. A failed launch leaves the task in its new column and records the failure.",
      ],
      [
        "Use jobs for recurring work",
        "For a scheduled or on-demand recurring task, use a job with a defined result and recovery path. The host and service must be available.",
      ],
    ],
    result:
      "A repeatable starting point, with the work and its actual outcome still visible.",
    next: "personas",
  },
  {
    id: "personas",
    label: "Define agent roles",
    title: "Give an agent a reusable role",
    color: "blue",
    desc: "Keep useful instructions available for the next task.",
    intro:
      "A persona is a launch profile: reusable instructions that give an agent a particular job or perspective.",
    needs:
      "A project and a clear role. Reviewer personas inspect a briefed target and return findings.",
    steps: [
      [
        "Define the perspective",
        "Write what the role should produce, what it should pay attention to and what is outside its scope.",
      ],
      [
        "Save the persona",
        "Project personas live in .agents/personas/. Use the supported persona format for your installed release.",
      ],
      [
        "Brief it on the actual work",
        "A reusable role still needs a concrete assignment: the target, expected outcome and relevant context.",
      ],
      [
        "Inspect what it returns",
        "A persona’s role does not make its output correct. Keep human judgment and review in the loop.",
      ],
    ],
    result:
      "A useful role you can brief again without rebuilding its instructions each time.",
    next: "reviews",
  },
  {
    id: "reviews",
    label: "Review the result",
    title: "Bring the right reviewers into the work",
    color: "purple",
    desc: "Request reviews, map owners and resolve findings.",
    intro:
      "A review keeps findings, discussion and status connected to the work being inspected. Requesting one is a step, not an approval.",
    needs:
      "A reviewable result and a briefing that says what changed and what the reviewer should inspect.",
    steps: [
      [
        "Choose the target",
        "Use the agent’s Review action or brief a reviewer persona on the relevant changes, document or artifact.",
      ],
      [
        "Use owners for project-file review",
        "The project’s .agents/owners.json map selects reviewer personas for changed file paths. Keep ownership rules aligned with the project.",
      ],
      [
        "Work through findings",
        "Reply with a fix or a reasoned explanation. The reviewer checks the response and resolves or dismisses the finding.",
      ],
      [
        "Make the final decision",
        "Check the result and any remaining findings. A review does not automatically authorize merging or publishing.",
      ],
    ],
    result:
      "A concrete record of what was questioned, what changed and what still needs a decision.",
    next: "agents",
  },
  {
    id: "setup",
    label: "Manage your installation",
    title: "Check setup and update issues",
    color: "purple",
    desc: "Providers, installation, updates and local access.",
    intro:
      "Keep product setup separate from the tools and environment your agents use.",
    needs:
      "The platform, release channel and exact error or unexpected behavior.",
    steps: [
      [
        "Check the agent CLI first",
        "Confirm Claude Code and Codex can sign in and work on the host using the accounts you intend to use. Existing subscriptions and provider limits still apply.",
      ],
      [
        "Check the installation path",
        "On macOS, save Settings, choose Start Server and allow background operation if asked; then use Open Dispatch from the menu bar. On Linux, PostgreSQL 14+ and a working systemd user session are required.",
      ],
      [
        "Set up Mac browser trust",
        "If the browser warns about the local HTTPS certificate, open native Settings → Network → HTTPS Certificate Trust. Export the CA certificate, add it to your login keychain in Keychain Access and set its SSL trust to Always Trust. Use the certificate from your own Dispatch installation.",
      ],
      [
        "Check the release channel",
        "Stable and Preview are different choices. Confirm a feature is in the release you installed before treating its absence as a setup fault.",
      ],
      [
        "Check remote access explicitly",
        "Another device needs a reachable host and the correct binding/trust setup. A localhost link on one machine is not automatically reachable from another.",
      ],
    ],
    result:
      "A specific problem to resolve, with the environment and release identified.",
    next: "agents",
  },
];
