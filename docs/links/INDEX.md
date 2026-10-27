# Карта скрытых связей — индекс

Связи, которые компилятор и тесты не ловят: «тронул X → обнови Y, потому что Z».
Файл домена подключает хук по его `paths:`, когда правка попала в эти пути (чтение молчит);
перед коммитом (impact-проход) открывай его по индексу. Формат строки:
`- <домен> — <файл>.md — <одна фраза>`, проверка ссылок и глобов:
`node ~/.ai-hooks/bin/check-impact-map.mjs`.

- hooks/guards/security — `hooks/guards/security.md` — пары гарда безопасности с ragsave, списки инструментов правки, алиасы
- hooks/guards/shell — `hooks/guards/shell.md` — shell-гард, роутер чтения, хук tokensave, регистрация хуков, разбор shell
- hooks/guards/session — `hooks/guards/session.md` — ключ ask mode, флаг skill-gate, конец хода по порогу, форма снимка передачи, лимиты вставки и плана, пункты bootstrap-ignore, подсказка /model opus
- hooks/ragsave — `hooks/ragsave.md` — код занятого замка, лог и отказ от автосинка
- hooks/logs — `hooks/logs.md` — общие пути и имена логов, каталог состояния, порог медленного хука
- install — `install.md` — цели симлинков и зашитые пути у потребителей, список MCP-серверов
