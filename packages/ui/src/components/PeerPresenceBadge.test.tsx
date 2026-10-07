import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { PeerPresenceBadge } from './PeerPresenceBadge';

describe('PeerPresenceBadge', () => {
  it('appends the queued count when work is waiting', () => {
    render(<PeerPresenceBadge online={true} queued={3} />);
    expect(screen.getByText('online · 3 queued')).toBeTruthy();
  });

  it('shows only the state when the queue is empty', () => {
    render(<PeerPresenceBadge online={false} queued={0} />);
    expect(screen.getByText('offline')).toBeTruthy();
  });
});
