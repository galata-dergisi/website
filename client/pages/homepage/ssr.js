import { render } from 'svelte/server';
import HomePage from './HomePage.svelte';

export default {
  render(props) {
    const { body } = render(HomePage, { props });
    return { html: body };
  },
};
