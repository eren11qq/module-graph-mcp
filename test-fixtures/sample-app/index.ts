// purpose: entry point; starts the three-layer chain and exercises named, side-effect and dynamic import styles
import { runApp } from './core/app';
import './core/emitter';
void import('./store/history');

runApp({ mode: 'demo' });
