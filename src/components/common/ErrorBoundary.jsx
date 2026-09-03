import { Component } from 'react';
import { trackClientEvent } from '../../utils/analytics.js';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, routeKey: this.getRouteKey() };
  }

  getRouteKey() {
    if (typeof window === 'undefined') return '';
    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidMount() {
    window.addEventListener('popstate', this.resetForRoute);
  }

  componentWillUnmount() {
    window.removeEventListener('popstate', this.resetForRoute);
  }

  resetForRoute = () => {
    const routeKey = this.getRouteKey();
    if (routeKey !== this.state.routeKey) {
      this.setState({ error: null, routeKey });
    }
  };

  componentDidCatch(error, info) {
    trackClientEvent('react_error_boundary', {
      message: error?.message || 'Unknown error',
      componentStack: info?.componentStack
    });
  }

  render() {
    if (this.state.error) {
      return (
        <main className="app-fallback" role="alert">
          <h1>Lookmefy needs a refresh</h1>
          <p>Something went wrong while loading this view. Refresh the page or return home.</p>
          <div>
            <button type="button" onClick={() => window.location.reload()}>Refresh</button>
            <a href="/home" onClick={() => this.setState({ error: null, routeKey: '/home' })}>Go home</a>
          </div>
        </main>
      );
    }

    return this.props.children;
  }
}
