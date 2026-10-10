// Имена параметров tokensave. Схемы read и правок отложены (deferred): модель
// зовёт их без схемы и угадывает имена по Read/Edit — `path` у read вместо
// `file`, `file` и `old_string` у str_replace вместо `path` и `old_str`, пары
// replacements объектами. Сервер отвечает «missing required parameter», и
// каждая ошибка стоит ещё одного вызова API. Здесь угаданное имя становится
// настоящим.
//
// Модуль чистый. Хук tool-args отдаёт результат в updatedInput, а гарды
// (security-guard, skill-gate) сверяют им путь: хуки идут параллельно и видят
// исходный вход, и правка по `file` иначе прошла бы мимо проверки `path`.

const ALIASES = {
  read: { file: ['path', 'file_path'] },
  str_replace: { path: ['file', 'file_path'], old_str: ['old_string'], new_str: ['new_string'] },
  multi_str_replace: { path: ['file', 'file_path'], replacements: ['edits'] },
};

const TOOL_RE = /tokensave_(read|str_replace|multi_str_replace)$/;

// Пара замены объектом — в [old, new]; что не разобрать, остаётся как есть.
function pair(item) {
  if (Array.isArray(item) || !item || typeof item !== 'object') return item;
  const from = item.old_str ?? item.old_string ?? item.old;
  const to = item.new_str ?? item.new_string ?? item.new;
  return typeof from === 'string' && typeof to === 'string' ? [from, to] : item;
}

// Вход с настоящими именами; тот же объект, если править нечего.
export function normalizeToolInput(toolName, toolInput) {
  const tool = TOOL_RE.exec(String(toolName || ''))?.[1];
  if (!tool || !toolInput || typeof toolInput !== 'object') return toolInput;
  const out = { ...toolInput };
  let changed = false;
  for (const [name, aliases] of Object.entries(ALIASES[tool])) {
    for (const alias of aliases) {
      if (!(alias in out)) continue;
      if (out[name] === undefined) out[name] = out[alias];
      delete out[alias];
      changed = true;
    }
  }
  if (Array.isArray(out.replacements)) {
    const pairs = out.replacements.map(pair);
    if (pairs.some((p, i) => p !== out.replacements[i])) {
      out.replacements = pairs;
      changed = true;
    }
  }
  return changed ? out : toolInput;
}
