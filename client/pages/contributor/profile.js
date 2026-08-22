(function enhanceProfileSearch() {
  var form = document.querySelector('.profile-search');
  var input = document.querySelector('#katki-arama');
  var status = document.querySelector('#katki-arama-durumu');
  var empty = document.querySelector('.profile-search-empty');
  var navigation = document.querySelector('.section-nav');
  var rows = Array.prototype.slice.call(document.querySelectorAll('.contribution-row'));
  var groups = Array.prototype.slice.call(document.querySelectorAll('.contribution-group'));
  var sections = Array.prototype.slice.call(document.querySelectorAll('main > section'));

  function normalize(value) {
    return String(value || '').toLocaleLowerCase('tr-TR').normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').replace(/\s+/g, ' ').trim();
  }

  function update() {
    var query = normalize(input.value);
    var matches = 0;
    rows.forEach(function (row) {
      var matched = !query || normalize(row.textContent).indexOf(query) !== -1;
      row.hidden = !matched;
      if (matched) matches += 1;
    });
    groups.forEach(function (group) {
      group.hidden = !Array.prototype.some.call(
        group.querySelectorAll('.contribution-row'),
        function (row) { return !row.hidden; }
      );
    });
    sections.forEach(function (section) {
      section.hidden = !Array.prototype.some.call(
        section.querySelectorAll('.contribution-row'),
        function (row) { return !row.hidden; }
      );
    });
    if (navigation) navigation.hidden = Boolean(query);
    empty.hidden = matches !== 0;
    status.textContent = query ? matches + ' eşleşme' : rows.length + ' katkı';
  }

  form.addEventListener('submit', function (event) { event.preventDefault(); });
  input.addEventListener('input', update);
  form.hidden = false;
  update();
}());
