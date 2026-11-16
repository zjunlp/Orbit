"""Enforce all rule families in the pinned upstream HLE web-tool policy."""
import ipaddress
import re
import socket
import unicodedata
from urllib.parse import unquote, urlsplit


class Blocked(ValueError):
    pass


def decoded(value):
    value = unicodedata.normalize('NFKC', value)
    for _ in range(6):
        new = unquote(value)
        if new == value:
            break
        value = new
    return value


def host(url):
    try:
        return (urlsplit(url).hostname or '').rstrip('.').encode('idna').decode().lower()
    except ValueError as exc:
        raise Blocked('invalid_url') from exc


def bare(url):
    return re.sub(r'^(?:https?://)?(?:www\.)?', '', decoded(url), flags=re.I).lower()


def in_domain(name, domains):
    return any(name == domain or name.endswith('.' + domain) for domain in domains)


class Policy:
    def __init__(self, rules, question):
        expected = {'domains', 'url_prefixes', 'serp_url_patterns', 'url_patterns',
                    'patterns_case_sensitive', 'answer_title_patterns', 'answer_title_allow_hosts'}
        if set(rules) != expected:
            raise ValueError('Unknown or missing upstream policy fields')
        self.rules = rules
        self.question_words = self.words(question)
        self.question_normalized = ''.join(self.question_words)
        self.patterns = [(family, [re.compile(p, 0 if family == 'patterns_case_sensitive' else re.I)
                                  for p in rules[family]]) for family in
                         ('url_patterns', 'patterns_case_sensitive')]

    @staticmethod
    def words(text):
        return re.findall(r'\w+', decoded(text).casefold())

    def text(self, value):
        value = decoded(value)
        for family, patterns in self.patterns:
            for i, pattern in enumerate(patterns):
                if pattern.search(value):
                    raise Blocked(f'{family}[{i}]')

    def url(self, value):
        raw = decoded(value)
        parsed = urlsplit(value)
        if parsed.scheme not in ('http', 'https') or parsed.username or parsed.password or not host(value):
            raise Blocked('invalid_url')
        if parsed.port not in (None, 80, 443):
            raise Blocked('non_web_port')
        self.text(raw)
        candidates = [raw, *re.findall(r'https?://[^\s<>"\'&]+', raw, re.I)]
        candidates += [raw[m.start():] for m in re.finditer(r'(?<![\w-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?::[0-9]+)?/', raw, re.I)]
        # Embedded encoded URLs and scheme-less archive/proxy targets are checked too.
        for domain in self.rules['domains']:
            if re.search(r'(?<![\w-])(?:[\w-]+\.)*' + re.escape(domain) + r'(?=[:/\s?#&]|$)', raw, re.I):
                raise Blocked('domains:' + domain)
        for candidate in candidates:
            normalized = bare(candidate)
            for i, prefix in enumerate(self.rules['url_prefixes']):
                if bare(prefix) in normalized:
                    raise Blocked(f'url_prefixes[{i}]')
            for i, pattern in enumerate(self.rules['serp_url_patterns']):
                if re.search(pattern, normalized, re.I):
                    raise Blocked(f'serp_url_patterns[{i}]')
        return value

    def query(self, value):
        if not isinstance(value, str) or not value.strip() or len(value) > 2000:
            raise Blocked('invalid_query')
        value = decoded(value)
        self.text(value)
        for name in re.findall(r'\bsite\s*:\s*([^\s]+)', value, re.I):
            name = host(name if '://' in name else 'https://' + name)
            if in_domain(name, self.rules['domains']):
                raise Blocked('blocked_site_domain')
        words = self.words(value)
        for i in range(max(0, len(words) - 7)):
            if ' '.join(words[i:i + 8]) in ' '.join(self.question_words):
                raise Blocked('question_verbatim_8_words')
        normalized = ''.join(words)
        if any(normalized[i:i + 50] in self.question_normalized
               for i in range(max(0, len(normalized) - 49))):
            raise Blocked('question_verbatim_50_characters')

    def result(self, url, title, snippet):
        self.url(url)
        self.text(title)
        self.text(snippet)
        if not in_domain(host(url), self.rules['answer_title_allow_hosts']):
            titles = [title, re.split(r'\s+(?:[|–—-])\s+', title)[0]]
            for i, pattern in enumerate(self.rules['answer_title_patterns']):
                if any(re.search(pattern, x.strip(), re.I) for x in titles):
                    raise Blocked(f'answer_title_patterns[{i}]')


def public_addresses(url):
    """Reject local services, metadata addresses and DNS answers outside public space."""
    name = host(url)
    addresses = socket.getaddrinfo(name, urlsplit(url).port or (443 if url.startswith('https:') else 80),
                                   type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise Blocked('non_public_address')
    return addresses
