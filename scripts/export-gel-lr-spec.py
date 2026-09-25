"""Export Gel's compiled LR tables and lexer keywords as a JSON prototype."""

import json

from edb.common import parsing
from edb.edgeql.parser import grammar
from edb.edgeql.parser.grammar import keywords, tokens


spec = parsing.load_parser_spec(grammar.start)
payload = json.loads(parsing.spec_to_json(spec))
payload["keyword_tokens"] = {
    keyword.lower(): token_name
    for keyword, (token_name, _kind) in keywords.edgeql_keywords.items()
}
payload["multiword_tokens"] = [
    name.lower() for name in tokens.Token.token_map if " " in name
]
print(json.dumps(payload, separators=(",", ":")))
