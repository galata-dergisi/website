package dotenv

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strings"
	"unicode"
)

func Load(paths ...string) (string, error) {
	for _, path := range paths {
		if path == "" {
			continue
		}

		info, err := os.Stat(path)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return "", fmt.Errorf("stat %s: %w", path, err)
		}
		if info.IsDir() {
			return "", fmt.Errorf("%s is a directory", path)
		}

		if err := loadFile(path); err != nil {
			return "", err
		}
		return path, nil
	}

	return "", nil
}

func loadFile(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open %s: %w", path, err)
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 4096), 1024*1024)
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "export ") || strings.HasPrefix(line, "export\t") {
			line = strings.TrimSpace(line[len("export"):])
		}

		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}

		key = strings.TrimSpace(key)
		if !validKey(key) {
			return fmt.Errorf("%s:%d: invalid key %q", path, lineNo, key)
		}

		parsed, err := parseValue(strings.TrimSpace(value))
		if err != nil {
			return fmt.Errorf("%s:%d: %w", path, lineNo, err)
		}

		if _, exists := os.LookupEnv(key); exists {
			continue
		}
		if err := os.Setenv(key, parsed); err != nil {
			return fmt.Errorf("%s:%d: set %s: %w", path, lineNo, key, err)
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}

	return nil
}

func validKey(key string) bool {
	if key == "" {
		return false
	}
	for index, r := range key {
		if index == 0 {
			if r != '_' && !unicode.IsLetter(r) {
				return false
			}
			continue
		}
		if r != '_' && !unicode.IsLetter(r) && !unicode.IsDigit(r) {
			return false
		}
	}
	return true
}

func parseValue(value string) (string, error) {
	if value == "" {
		return "", nil
	}

	switch value[0] {
	case '"':
		parsed, end, err := parseDoubleQuoted(value)
		if err != nil {
			return "", err
		}
		return parsed, checkTrailing(value[end+1:])
	case '\'':
		end := strings.IndexByte(value[1:], '\'')
		if end < 0 {
			return "", errors.New("unterminated quoted value")
		}
		end++
		return value[1:end], checkTrailing(value[end+1:])
	default:
		return strings.TrimSpace(stripInlineComment(value)), nil
	}
}

func parseDoubleQuoted(value string) (string, int, error) {
	finish := func(end int) (string, int, error) {
		return strings.ReplaceAll(value[1:end], `\n`, "\n"), end, nil
	}

	ambiguousCommentEnd := -1
	consecutiveBackslashes := 0
	for i := 1; i < len(value); i++ {
		switch value[i] {
		case '\\':
			consecutiveBackslashes++
			continue
		case '"':
			trailing := value[i+1:]
			trimmedTrailing := strings.TrimSpace(trailing)
			trailingIsEmpty := trimmedTrailing == ""
			trailingIsComment := strings.HasPrefix(trimmedTrailing, "#")

			if consecutiveBackslashes == 0 {
				if ambiguousCommentEnd >= 0 && !trailingIsEmpty && !trailingIsComment {
					return finish(ambiguousCommentEnd)
				}
				return finish(i)
			}
			if trailingIsEmpty {
				return finish(i)
			}
			if trailingIsComment {
				ambiguousCommentEnd = i
			}
		}
		consecutiveBackslashes = 0
	}
	if ambiguousCommentEnd >= 0 {
		return finish(ambiguousCommentEnd)
	}
	return "", 0, errors.New("unterminated quoted value")
}

func checkTrailing(trailing string) error {
	trailing = strings.TrimSpace(trailing)
	if trailing == "" || strings.HasPrefix(trailing, "#") {
		return nil
	}
	return fmt.Errorf("unexpected trailing content %q", trailing)
}

func stripInlineComment(value string) string {
	for index, r := range value {
		if r == '#' && (index == 0 || unicode.IsSpace(rune(value[index-1]))) {
			return value[:index]
		}
	}
	return value
}
