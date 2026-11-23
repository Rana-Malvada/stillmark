"""Reject transaction escapes in migration statements, not PL/pgSQL function bodies."""
import re


def statement_text(text):
    # Remove SQL strings, quoted identifiers, dollar-quoted bodies and comments.
    # Unterminated tokens fail closed instead of hiding a subsequent statement.
    out = []
    i = 0
    while i < len(text):
        if text.startswith('--', i):
            j = text.find('\n', i)
            i = len(text) if j < 0 else j
        elif text.startswith('/*', i):
            depth = 1
            i += 2
            while depth and i < len(text):
                if text.startswith('/*', i):
                    depth += 1
                    i += 2
                elif text.startswith('*/', i):
                    depth -= 1
                    i += 2
                else:
                    i += 1
            if depth:
                raise ValueError('Unterminated SQL comment')
        elif text[i] in "'\"":
            quote = text[i]
            i += 1
            while i < len(text):
                if text[i] == quote:
                    i += 1
                    if i < len(text) and text[i] == quote:
                        i += 1
                        continue
                    break
                # Backslash escapes are deliberately rejected, avoiding ambiguity
                # between standard strings and E strings.
                if text[i] == '\\':
                    raise ValueError('Use standard SQL or dollar quoting')
                i += 1
            else:
                raise ValueError('Unterminated SQL quote')
        elif text[i] == '$' and (m := re.match(r'\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$', text[i:])):
            tag = m.group()
            j = text.find(tag, i + len(tag))
            if j < 0:
                raise ValueError('Unterminated SQL body')
            i = j + len(tag)
        else:
            out.append(text[i])
            i += 1
            continue
        out.append(' ')
    return ''.join(out)


def transactional(text):
    clean = statement_text(text)
    # END closes CASE expressions too; only a statement-leading END ends a transaction.
    return not (
        re.search(r'\\|\b(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|ABORT|VACUUM|CONCURRENTLY)\b', clean, re.I)
        or re.search(r'(?:^|;)\s*END\b', clean, re.I)
    )
