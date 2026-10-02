# Glossário

| Termo | Significado |
|---|---|
| Brain | conhecimento durável do projeto em `.project/` + `CLAUDE.md` |
| Orchestrator | agente principal com quem você conversa; delega a subagentes |
| Worktree de tarefa | `git worktree` isolado onde uma tarefa autônoma roda (`task/<slug>`) |
| Checkpoint | commit no branch de um worktree; ponto de retorno da timeline |
| Hotspot | arquivo com muita mudança recente e muito código — candidato a refactor |
| Acoplamento temporal | arquivos que mudam juntos com frequência no histórico |
| Sidecar | processo Node com o Claude Agent SDK, iniciado pelo app Tauri |
