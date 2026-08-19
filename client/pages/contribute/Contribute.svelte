<!--
  Copyright 2020 Mehmet Baker

  This file is part of galata-dergisi.

  galata-dergisi is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  galata-dergisi is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with galata-dergisi. If not, see <https://www.gnu.org/licenses/>.
-->

<script>
  import { onMount, tick } from 'svelte';
  import {
    acceptedFileTypes,
    fileMatchesAssetType,
  } from '../../lib/contribution-file-policy.mjs';

  // 50 MB
  const MAX_FILE_SIZE = 1024 * 1024 * 50;
  const development = Boolean(window.galataDevelopment);

  let assetType = $state();
  let darkMode = $state(false);
  let submitting = $state(false);

  // DOM Elements
  let form = $state();
  let fileInput = $state();
  let fileInputText = $state();
  let assetTypeInput = $state();

  function resetTurnstile() {
    if (!development && window.turnstile) window.turnstile.reset();
  }

  function syncAssetTypeOptions(instance) {
    const menu = document.getElementById(instance.input.dataset.target);
    if (!menu) return;
    menu.setAttribute('role', 'listbox');
    menu.querySelectorAll('li').forEach((option) => {
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(option.classList.contains('selected')));
      if (option.classList.contains('disabled')) option.setAttribute('aria-disabled', 'true');
    });
  }

  function initializeAssetTypeSelect() {
    const existing = M.FormSelect.getInstance(assetTypeInput);
    if (existing) existing.destroy();

    let trigger;
    const instance = M.FormSelect.init(assetTypeInput, {
      dropdownOptions: {
        onOpenStart: () => trigger.setAttribute('aria-expanded', 'true'),
        onCloseEnd: () => trigger.setAttribute('aria-expanded', 'false'),
      },
    });
    trigger = instance.input;
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-labelledby', 'assetTypeLabel');
    trigger.setAttribute('aria-controls', trigger.dataset.target);
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-required', 'true');
    syncAssetTypeOptions(instance);
    return instance;
  }

  async function resetForm() {
    form.reset();
    assetType = '';
    await tick();

    initializeAssetTypeSelect();
    M.updateTextFields();
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    form.reportValidity();

    if (form.checkValidity()) {
      const formData = new FormData(form);
      if (development) {
        formData.set(
          'cf-turnstile-response',
          window.galataDevelopment.captchaToken,
        );
      }

      if (!formData.get('assetType')) {
        const { input } = M.FormSelect.getInstance(assetTypeInput);
        input.readOnly = false;
        input.setCustomValidity('Lütfen Eser Türü seçimi yapınız.');
        input.setAttribute('aria-invalid', 'true');
        input.reportValidity();
        input.readOnly = true;
        return;
      }

      if (!formData.get('cf-turnstile-response')) {
        M.toast({
          html: 'Lütfen güvenlik doğrulamasını tamamlayınız.',
          classes: 'yellow darken-4',
        });
        return;
      }

      submitting = true;
      try {
        const response = await fetch('/katkida-bulunun', {
          method: 'POST',
          body: formData,
        });
        const result = await response.json();

        if (!result.ok) {
          M.toast({
            html: result.message,
            classes: 'red darken-3',
          });
          return;
        }

        M.toast({
          html: 'Gönderi tamamlandı, katkınız için teşekkür ederiz.',
          classes: 'teal darken-3',
        });

        await resetForm();
      } catch (ex) {
        console.trace(ex);
        M.toast({
          html: 'Beklenmedik bir hata oluştu, lütfen sayfayı yenileyip tekrar deneyin.',
          classes: 'red darken-3',
        });
      } finally {
        resetTurnstile();
        submitting = false;
      }
    }
  }

  function ensureFileMatchesAssetType() {
    if (!fileInput) return;
    const assetTypeEmpty = !assetType;
    const videoAsset = assetType === 'video';
    const fileMatches = !videoAsset
      && fileInput.files.length
      && fileMatchesAssetType(fileInput.files[0], assetType);

    if (assetTypeEmpty || videoAsset || !fileMatches) {
      fileInput.value = '';
      fileInputText.value = '';
      fileInputText.classList.remove('valid');
      return;
    }
  }

  async function onAssetTypeChange() {
    let instance = null;
    if (assetTypeInput.value) {
      instance = M.FormSelect.getInstance(assetTypeInput);
      const { input } = instance;
      input.setCustomValidity('');
      input.removeAttribute('aria-invalid');
    }

    ensureFileMatchesAssetType();
    if (instance) {
      await tick();
      syncAssetTypeOptions(instance);
    }
  }

  if (window.matchMedia) {
    darkMode = matchMedia('(prefers-color-scheme: dark)').matches;
  }

  onMount(() => {
    M.AutoInit();
    initializeAssetTypeSelect();
  });
</script>

<style>
  :global(html, body) {
    margin: 0;
    padding: 0;
  }

  :global(body) {
    width: 100%;
    height: 100%;
  }

  :global(*) {
    box-sizing: border-box;
  }

  .container {
    min-height: 100vh;
    padding-top: 24px;
    padding-bottom: 20px;
  }

  @media only screen and (min-width: 768px) {
    .container {
      box-shadow: 0 0 5px 0px #888;
    }
  }

  h3 {
    margin-top: 0;
  }

  .page-container {
    width: 100%;
    height: 100%;
    background: #bdbdbd;
  }

  .container {
    background: #eee;
  }

  :global(.file-field .btn:has(input[type='file']:focus-visible)) {
    outline: 3px solid #004d40;
    outline-offset: 3px;
  }

  @media (prefers-color-scheme: dark) {
    .page-container {
      background: #222;
    }

    .container {
      background: #424242;
      box-shadow:  0 5px 0px #1e1e1e;
    }

    h3 {
      color: #8e8e8e;
    }

    .helper-text {
      color: #b5b5b5 !important;
    }

    :global(input, .dropdown-content li:not(.disabled) span, textarea) {
      color: #bbb !important;
    }

    :global(svg.caret) {
      fill: #bbb !important;
    }

    :global(.dropdown-content li.disabled span) {
      color: #868686;
    }

    :global(.dropdown-content) {
      background: #4d4d4d !important;
    }

    :global(input:not(.browser-default).invalid ~ .helper-text[data-error]) {
      color: transparent !important;
    }

    :global(input:not(.browser-default).invalid ~ .helper-text::after),
    :global(input:not(.browser-default).invalid:focus ~ label) {
      color: #d9bb45 !important;
    }

    :global(input.invalid:not(.browser-default)) {
      border-bottom: 1px solid #d9bb45 !important;
      box-shadow: 0 1px 0 0 #d9bb45 !important;
    }

    :global(.file-field .btn:has(input[type='file']:focus-visible)) {
      outline-color: #fff;
    }
  }

  @media (forced-colors: active) {
    :global(.file-field .btn:has(input[type='file']:focus-visible)) {
      outline-color: Highlight;
    }
  }
</style>

<div class="page-container">
  <div class="container">
    <h3 class="center-align">Katkıda Bulunun</h3>

    <div class="row">
      <form class="col s12" onsubmit={onSubmit} bind:this={form}>
        <div hidden>
          <label for="contactWebsite">Web sitesi</label>
          <input
            type="text"
            id="contactWebsite"
            name="contactWebsite"
            autocomplete="off"
            tabindex="-1"
          />
        </div>

        <div class="row">
          <div class="input-field col s12">
            <input type="text" id="name" name="name" maxlength="40" class="validate" required />
            <label for="name">İsminiz</label>
            <span class="helper-text" data-error="Lütfen isminizi giriniz.">
              Buraya yazdığınız isim "Katkıda Bulunanlar" sayfasında kullanılacaktır.
            </span>
          </div>
        </div>

        <div class="row">
          <div class="input-field col s12">
            <input type="email" id="email" name="email" maxlength="100" class="validate" required />
            <label for="email">Eposta Adresiniz</label>
            <span class="helper-text" data-error="Lütfen geçerli bir eposta adresi giriniz.">
              Editörlerimiz sizinle bu adresten iletişime geçecek.
            </span>
          </div>
        </div>

        <div class="row">
          <div class="input-field col s12">
            <input type="text" id="title" name="title" maxlength="120" class="validate" required />
            <label for="title">Başlık</label>
            <span class="helper-text" data-error="Lütfen bir başlık giriniz.">
              Buraya yazdığınız başlık "Katkıda Bulunanlar" sayfasında kullanılacaktır.
            </span>
          </div>
        </div>

        <div class="row">
          <div class="input-field col s12">
            <select
              bind:value={assetType}
              bind:this={assetTypeInput}
              name="assetType"
              id="assetType"
              onchange={onAssetTypeChange}
              >
              <option value="" disabled="disabled" selected="selected">Seçiniz...</option>
              <option value="siir">Şiir</option>
              <option value="oyku">Öykü</option>
              <option value="deneme">Deneme</option>
              <option value="roportaj">Röportaj</option>
              <option value="elestiri">Eleştiri, İnceleme</option>
              <option value="resim">Resim</option>
              <option value="ses">Ses</option>
              <option value="video">Video</option>
            </select>
            <label id="assetTypeLabel" for="assetType">Eser Türü</label>
          </div>
        </div>

        {#if assetType === 'video'}
          <div class="row">
            <div class="input-field col s12">
              <input type="url" id="videoLink" name="videoLink" maxlength="255" class="validate" required />
              <label for="videoLink">YouTube Linki</label>
              <span class="helper-text" data-error="Lütfen geçerli bir video adresi giriniz."></span>
            </div>
          </div>
        {/if}

        <div class="row">
          <div class="input-field col s12">
            <textarea id="message" name="message" class="materialize-textarea" maxlength="5000"></textarea>
            <label for="message">Mesajınız</label>
            <span class="helper-text">
              Mesajınız katkınızla birlikte editörlerimize ulaştırılacaktır.
            </span>
          </div>
        </div>

        {#if assetType !== 'video'}
          <div class="row">
            <div class="file-field input-field col s12">
              <div class="btn">
                <span>Dosya</span>
                <input
                  bind:this={fileInput}
                  onchange={(e) => {
                    if (e.target.files.length && e.target.files[0].size > MAX_FILE_SIZE) {
                      e.target.setCustomValidity("Lütfen 50 MiB'den küçük veya eşit bir dosya seçiniz.");
                      e.target.reportValidity();
                    } else {
                      e.target.setCustomValidity('');
                    }
                  }}
                  type="file"
                  name="file"
                  aria-label="Dosya seç"
                  required="required"
                  accept={acceptedFileTypes(assetType)} />
              </div>
              <div class="file-path-wrapper">
                <input bind:this={fileInputText} class="file-path validate" type="text" placeholder="Dosya seçiniz." />
              </div>
            </div>
          </div>
        {/if}

        {#if development}
          <div class="card-panel amber lighten-4 brown-text text-darken-4">
            Geliştirme modu: CAPTCHA devre dışıdır. Bu gönderi yalnızca yerel
            contributions gelen kutusuna kaydedilecektir.
          </div>
        {:else}
          <div
            class="cf-turnstile"
            data-theme="{darkMode ? 'dark' : 'light'}"
            data-sitekey="0x4AAAAAAEFQTSL_Bceyu_qG"
            data-language="tr"
            data-action="contribution"
          ></div>
        {/if}

        <br />

        <button
          type="submit"
          class="btn waves-effect waves-light"
          disabled={submitting}
        >Gönder</button>
      </form>
    </div>
  </div>
</div>
