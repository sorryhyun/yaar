import './styles.css';
import { startGame } from './game';

const root = document.getElementById('app') ?? document.body;
startGame(root);
