<!--
  Font Awesome Free 5.15.4 by Fonticons, Inc. - https://fontawesome.com
  SVG icon data is licensed under CC BY 4.0: https://creativecommons.org/licenses/by/4.0/
-->

<script>
  import iconLibrary from '../../../lib/font-awesome-icons.js';

  const spriteIcons = Object.entries(iconLibrary.icons).map(([name, icon]) => ({
    ...icon,
    id: iconLibrary.symbolId(name),
  }));
</script>

<style>
  svg {
    height: 0;
    overflow: hidden;
    position: absolute;
    width: 0;
  }
</style>

<svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
  <defs>
    {#each spriteIcons as icon (icon.id)}
      <symbol id={icon.id} viewBox={icon.viewBox}>
        <path d={icon.path}></path>
      </symbol>
    {/each}
  </defs>
</svg>
