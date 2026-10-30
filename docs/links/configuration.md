---
paths:
  - "bin/codex-install.mjs"
  - "ai-hooks/bin/project-init.sh"
  - "docs/codex.md"
  - "ai-hooks/test/test-codex.mjs"
---

## Каталоги Codex
- `CODEX_HOME` — `bin/codex-install.mjs:codexHome` задаёт каталог установки; `ai-hooks/bin/project-init.sh:lock_dir` размещает блокировки в `$CODEX_HOME/state`, если не задан `AI_HOOKS_STATE_DIR`. `docs/codex.md` описывает этот контракт; `ai-hooks/test/test-codex.mjs` проверяет пользовательский каталог и отсутствие записей при `--check`. Согласованно обновлять установщик, блокировки, документацию и тест при изменении поведения.
