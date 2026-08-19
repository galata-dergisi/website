package dotenv

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadParsesDotEnvAndUsesFirstExistingPath(t *testing.T) {
	keys := []string{
		"DOTENV_TEST_ALPHA",
		"DOTENV_TEST_DOUBLE",
		"DOTENV_TEST_SINGLE",
		"DOTENV_TEST_INLINE",
		"DOTENV_TEST_HASH",
		"DOTENV_TEST_SPACED",
		"DOTENV_TEST_EMPTY",
		"DOTENV_TEST_ESCAPED",
	}
	unsetEnv(t, keys...)

	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	otherPath := filepath.Join(dir, "other.env")
	if err := os.WriteFile(envPath, []byte(`
# ignored
export DOTENV_TEST_ALPHA=from-file
DOTENV_TEST_DOUBLE="hello # world"
DOTENV_TEST_SINGLE='single # value'
DOTENV_TEST_INLINE=keep this # drop this
DOTENV_TEST_HASH=keep#hash
DOTENV_TEST_SPACED = spaced value
DOTENV_TEST_EMPTY=
DOTENV_TEST_ESCAPED="line\nnext\t\"quoted\""
`), 0o600); err != nil {
		t.Fatalf("write .env: %v", err)
	}
	if err := os.WriteFile(otherPath, []byte("DOTENV_TEST_ALPHA=wrong\n"), 0o600); err != nil {
		t.Fatalf("write other .env: %v", err)
	}

	loadedPath, err := Load(filepath.Join(dir, "missing.env"), envPath, otherPath)
	if err != nil {
		t.Fatalf("load .env: %v", err)
	}
	if loadedPath != envPath {
		t.Fatalf("expected %s to load, got %s", envPath, loadedPath)
	}

	expected := map[string]string{
		"DOTENV_TEST_ALPHA":   "from-file",
		"DOTENV_TEST_DOUBLE":  "hello # world",
		"DOTENV_TEST_SINGLE":  "single # value",
		"DOTENV_TEST_INLINE":  "keep this",
		"DOTENV_TEST_HASH":    "keep#hash",
		"DOTENV_TEST_SPACED":  "spaced value",
		"DOTENV_TEST_EMPTY":   "",
		"DOTENV_TEST_ESCAPED": "line\nnext\\t\\\"quoted\\\"",
	}
	for key, value := range expected {
		if actual := os.Getenv(key); actual != value {
			t.Fatalf("%s: expected %q, got %q", key, value, actual)
		}
	}
}

func TestParseValuePreservesDotenv10DoubleQuotedBackslashes(t *testing.T) {
	tests := []struct {
		name  string
		value string
		want  string
	}{
		{name: "newline", value: `"line\nnext"`, want: "line\nnext"},
		{name: "tab", value: `"line\tnext"`, want: `line\tnext`},
		{name: "carriage return", value: `"line\rnext"`, want: `line\rnext`},
		{name: "unknown escape", value: `"a\qb"`, want: `a\qb`},
		{name: "escaped quotes", value: `"say \"hello\""`, want: `say \"hello\"`},
		{name: "escaped quote before hash", value: `"say \"#hello\""`, want: `say \"#hello\"`},
		{name: "escaped quote before spaced hash", value: `"say \" #hello"`, want: `say \" #hello`},
		{name: "repeated backslashes before hash quote", value: `"say \\"#hello"`, want: `say \\"#hello`},
		{name: "escaped hash value before quoted comment", value: `"say \"#hello\"" # note "rotate"`, want: `say \"#hello\"`},
		{name: "embedded quote after repeated backslashes", value: `"a\\"b"`, want: `a\\"b`},
		{name: "repeated backslashes", value: `"a\\b"`, want: `a\\b`},
		{name: "dollar", value: `"a\$b"`, want: `a\$b`},
		{name: "hash", value: `"a\#b"`, want: `a\#b`},
		{name: "windows path", value: `"C:\path\file"`, want: `C:\path\file`},
		{name: "overlapping newline escape", value: `"a\\nb"`, want: "a\\\nb"},
		{name: "trailing backslash", value: `"abc\"`, want: `abc\`},
		{name: "quoted comment", value: `"secret" # note "rotate"`, want: `secret`},
		{name: "immediate quoted comment", value: `"secret"# note "rotate"`, want: `secret`},
		{name: "trailing backslash before comment", value: `"C:\path\" # note "rotate"`, want: `C:\path\`},
		{name: "trailing backslash before immediate comment", value: `"C:\path\"# note "rotate"`, want: `C:\path\`},
		{name: "repeated trailing backslashes before immediate comment", value: `"C:\path\\"# note "rotate"`, want: `C:\path\\`},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseValue(tc.value)
			if err != nil {
				t.Fatalf("parseValue(%q): %v", tc.value, err)
			}
			if got != tc.want {
				t.Fatalf("parseValue(%q) = %q, want %q", tc.value, got, tc.want)
			}
		})
	}
}

func TestLoadDoesNotOverrideExistingEnvironment(t *testing.T) {
	const key = "DOTENV_TEST_EXISTING"
	unsetEnv(t, key)
	if err := os.Setenv(key, "process"); err != nil {
		t.Fatalf("set env: %v", err)
	}

	envPath := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(envPath, []byte(key+"=file\n"), 0o600); err != nil {
		t.Fatalf("write .env: %v", err)
	}

	if _, err := Load(envPath); err != nil {
		t.Fatalf("load .env: %v", err)
	}
	if actual := os.Getenv(key); actual != "process" {
		t.Fatalf("expected process env to win, got %q", actual)
	}
}

func TestLoadMissingDotEnvIsNonFatal(t *testing.T) {
	loadedPath, err := Load(filepath.Join(t.TempDir(), ".env"))
	if err != nil {
		t.Fatalf("missing .env should not fail: %v", err)
	}
	if loadedPath != "" {
		t.Fatalf("expected no loaded path, got %s", loadedPath)
	}
}

func TestLoadMalformedDotEnvFails(t *testing.T) {
	cases := map[string]string{
		"invalid key":         "DOTENV TEST BAD=value\n",
		"unterminated quote":  "DOTENV_TEST_BAD=\"value\n",
		"unexpected trailing": "DOTENV_TEST_BAD=\"value\" trailing\n",
	}

	for name, contents := range cases {
		t.Run(name, func(t *testing.T) {
			envPath := filepath.Join(t.TempDir(), ".env")
			if err := os.WriteFile(envPath, []byte(contents), 0o600); err != nil {
				t.Fatalf("write .env: %v", err)
			}

			_, err := Load(envPath)
			if err == nil {
				t.Fatal("expected malformed .env to fail")
			}
			if !strings.Contains(err.Error(), envPath) {
				t.Fatalf("expected error to include path, got %v", err)
			}
		})
	}
}

func TestLoadIgnoresNonAssignmentLines(t *testing.T) {
	keys := []string{"DOTENV_TEST_BEFORE", "DOTENV_TEST_AFTER"}
	unsetEnv(t, keys...)

	envPath := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(envPath, []byte(`
DOTENV_TEST_BEFORE=before
QUERY EXECUTED
DOTENV_TEST_AFTER=after
`), 0o600); err != nil {
		t.Fatalf("write .env: %v", err)
	}

	if _, err := Load(envPath); err != nil {
		t.Fatalf("load .env: %v", err)
	}
	if actual := os.Getenv("DOTENV_TEST_BEFORE"); actual != "before" {
		t.Fatalf("expected assignment before ignored line, got %q", actual)
	}
	if actual := os.Getenv("DOTENV_TEST_AFTER"); actual != "after" {
		t.Fatalf("expected assignment after ignored line, got %q", actual)
	}
}

func unsetEnv(t *testing.T, keys ...string) {
	t.Helper()
	for _, key := range keys {
		key := key
		original, hadOriginal := os.LookupEnv(key)
		if err := os.Unsetenv(key); err != nil {
			t.Fatalf("unset %s: %v", key, err)
		}
		t.Cleanup(func() {
			if hadOriginal {
				_ = os.Setenv(key, original)
				return
			}
			_ = os.Unsetenv(key)
		})
	}
}
