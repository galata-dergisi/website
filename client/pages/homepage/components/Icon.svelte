<!-- Copyright 2026 Mehmet Baker -->

<script>
  import iconLibrary from '../../../lib/font-awesome-icons.js';

  let { name, className = '' } = $props();

  let icon = $derived(iconLibrary.getIcon(name));
  let iconHref = $derived(`#${iconLibrary.symbolId(name)}`);
</script>

<style>
  svg {
    display: inline-block;
    fill: currentColor;
    height: 1em;
    overflow: visible;
    vertical-align: -0.125em;
    width: 1em;
  }
</style>

<svg
  class={className}
  aria-hidden="true"
  focusable="false"
  viewBox={icon.viewBox}
  xmlns="http://www.w3.org/2000/svg">
  <use href={iconHref} width="100%" height="100%"></use>
</svg>
