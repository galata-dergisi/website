# galata-dergisi

[Türkçe için tıklayınız.](README-TR.md)

Source code of https://galatadergisi.org.

## Public content and SEO

See [the public-content and SEO guide](docs/public-content.md) for the canonical
public catalog, server-rendered reader, contributor profiles, and sitemap.

The production design is documented in the
[immutable-site architecture](docs/immutable-site-architecture.md) and
[operations runbook](docs/immutable-site-operations.md). Node and Svelte are
build-only tools; the production application is a standard-library Go server
serving an immutable embedded site.

For a watched local frontend, generated site, Go server, and local media, see the
[full-stack development guide](docs/development.md) and run `npm run dev`.

## Contributing to galata-dergisi

* If you want to report an issue or request a new feature then please [create an issue](https://github.com/galata-dergisi/galata-dergisi/issues).
* If you want to contribute to the software then please open an issue first and then assign it to yourself. Otherwise there is a chance for us to be working on the same thing since we don't publish our roadmap.

## License

![GNU GPLv3 - Free as ın Freedom](https://www.gnu.org/graphics/gplv3-with-text-136x68.png)

GNU General Public License v3.0 or later.

See [COPYING](COPYING) to see the full text.
