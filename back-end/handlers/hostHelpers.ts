import playerDb from '../db/player.ts';
import hostDb from '../db/host.ts';
import IGame from '../interfaces/IGame.ts';
import { GameStates } from '../interfaces/IGameState.ts';
import playerHelpers from './playerHelpers.ts'
import { Server } from 'socket.io';
//import { Socket } from 'socket.io'
import Player from '../models/Player.ts';
import { PlayerStates } from '../interfaces/IPlayerState.ts';
import IPlayer from '../interfaces/IPlayer.ts';
import IGuess from '../interfaces/IGuess.ts';

const PRE_QUIZ_MS = 5000;
const PRE_ANSWER_MS = 5000;
const PRE_LEADER_BOARD_MS = 5000;
let nextQuestionTimer;

const hostGoNext = async (gameId: number, io: Server): Promise<void> => {
  const currentGameData: IGame | null = await hostDb.getGameData(gameId);
  if (currentGameData === null) {
    return;
  }

  io.to(currentGameData.hostSocketId).emit('host-next', currentGameData);
}

const hostShowLeaderBoard = async (gameId: number, io: Server): Promise<void> => {
  await hostDb.setGameState(gameId, GameStates.LeaderBoard);

  const playerScores = await playerDb.getPlayerScores(gameId);
  playerScores.sort((a, b) => b.score - a.score);
  const players = await playerDb.getPlayers(gameId);
  for(let i = 0; i < players.length; i++) {
    if (players[i].score === playerScores[0].score) {
      await playerDb.updatePlayerState(players[i].id, PlayerStates.RankOne, io, {});
    }
    else if (players[i].score === playerScores[1].score) {
      await playerDb.updatePlayerState(players[i].id, PlayerStates.RankTwo, io, {});
    }
    else if (players[i].score === playerScores[2].score) {
      await playerDb.updatePlayerState(players[i].id, PlayerStates.RankThree, io, {});
    }
    else{
      await playerDb.updatePlayerState(players[i].id, PlayerStates.LeaderBoard, io, {});
    }
  }

  const gameData: IGame | null = await hostDb.getGameData(gameId);
  if (!gameData) {
    return;
  }
  
  io.to(gameData.hostSocketId).emit('host-next', { ...gameData, playerScores });
}

const hostPreLeaderBoard = async (gameId: number, io: Server): Promise<void> => {
  const playerScores = await playerDb.getPlayerScores(gameId);
  playerScores.sort((a, b) => b.score - a.score);
  if (playerScores[0].score === playerScores[1].score) {
    await hostDb.setGameState(gameId, GameStates.Tiebreaker);
    await hostGoNext(gameId, io);
    await new Promise(r => setTimeout(r, 5900));
    try {
      await hostDb.addTiebreakerQuestion(gameId);
      await hostNextQuestionOrLeaderboard(gameId, io);
    } catch (e) {
      console.error(`Failed to go to questionnaire: ${e}`)
    }
  } else {
    await hostDb.setGameState(gameId, GameStates.PreLeaderBoard);
    await hostGoNext(gameId, io);
    await playerDb.updateAllPlayerStates(gameId, PlayerStates.PreLeaderBoard, io, {});
    setTimeout(hostShowLeaderBoard, PRE_LEADER_BOARD_MS, gameId, io);
  }
}

const hostStartQuizTimer = async (gameId: number, io: Server): Promise<void> => {
  const currentGameData: IGame | null = await hostDb.getGameData(gameId);
  let timePerQuestionMS: number;
  if (currentGameData?.settings.timePerQuestion === undefined) {
    console.error("Error: time per question undefined. Defaulted to 15 seconds.");
    timePerQuestionMS = 15000;
  }
  else {
    timePerQuestionMS = currentGameData?.settings.timePerQuestion * 1000;
  }

  playerHelpers.allPlayersQuizTimerStarted(gameId, io);
  nextQuestionTimer = setTimeout(hostPreAnswer, timePerQuestionMS, gameId, io);
}

const hostNextQuestionOrLeaderboard = async (gameId: number, io: Server): Promise<void> => {
  const shouldContinue = await hostDb.nextQuestion(gameId);

  if (shouldContinue) {
    await hostDb.setGameState(gameId, GameStates.ShowingQuestion);
    await hostGoNext(gameId, io);
    await playerHelpers.allPlayersGoToNextQuestion(gameId, io);
  } else {
    await hostPreLeaderBoard(gameId, io);
  }
}

const hostSkipTimer = async (gameId: number, io: Server): Promise<void> => {
  clearTimeout(nextQuestionTimer);
  hostPreAnswer(gameId, io);  
}

const hostStartQuiz = async (gameId: number, io: Server): Promise<void> => {
  await hostDb.setGameState(gameId, GameStates.PreQuiz);
  const data = await hostDb.getGameData(gameId)
  const questions = data?.questionnaireQuestions;
  const numQuizQuestions = data?.settings.numQuizQuestions || 5;
  await hostDb.buildQuiz(gameId, questions, numQuizQuestions);
  await hostGoNext(gameId, io);
  setTimeout(hostNextQuestionOrLeaderboard, PRE_QUIZ_MS, gameId, io);
}

const hostShowIntLeaderboard = async(gameId: number, io:Server): Promise<void> => {
  await hostDb.setGameState(gameId, GameStates.InterLeaderboard);

  const allPlayerScores = await playerDb.getPlayerScores(gameId);
  await playerDb.updateAllPlayerStates(gameId, PlayerStates.SeeingRank, io, {playerScores: allPlayerScores});
  
  const gameData = await hostDb.getGameData(gameId);
  if (gameData === null) {
    return;
  }
  const handsFreeMode = gameData.settings.handsFreeMode;
  const timePerLeaderboard = gameData.settings.timePerLeaderboard * 1000;
  io.to(gameData.hostSocketId).emit('host-next', { ...gameData, playerScores: allPlayerScores});

  if (handsFreeMode) {
    setTimeout(hostNextQuestionOrLeaderboard, timePerLeaderboard, gameId, io)
  }
}

const hostPreAnswer = async (gameId: number, io: Server): Promise<void> => {
  await hostDb.setGameState(gameId, GameStates.PreAnswer);
  await hostGoNext(gameId, io);
  await playerHelpers.allPlayersTimesUp(gameId, io);

  setTimeout(hostShowAnswer, PRE_ANSWER_MS, gameId, io);
}

const handleTiebreakerAnswers = async (allPlayers: IPlayer[], quizQIndex, correctQIndex): Promise<void> => {
  if (allPlayers.length < 1) {
    return;
  }

  const playerLeaderboard = [...allPlayers];
  playerLeaderboard.sort((a, b) => b.score - a.score);

  const topPlayers = playerLeaderboard.filter(p => p.score === playerLeaderboard[0].score);
  if (topPlayers.length === 1) {
    return;
  }

  const bottomPlayersBySpeed = playerDb.getPlayersSortedByGuessSpeed(topPlayers, quizQIndex);
  let bonusPlayer: IPlayer = bottomPlayersBySpeed[0];
  for (let i = 1; i < bottomPlayersBySpeed.length; i++) {
    const currentPlayer = bottomPlayersBySpeed[i];
    const currentGuess = currentPlayer.quizGuesses[quizQIndex];
    if (currentGuess && currentGuess.guess === correctQIndex) {
      bonusPlayer = currentPlayer;
    }
  }
  
  await playerDb.awardPlayerPoints(bonusPlayer.id, 100);
}

const hostShowAnswer = async (gameId: number, io: Server): Promise<void> => {
  await hostDb.setGameState(gameId, GameStates.ShowingAnswer);
  const gameData = await hostDb.getGameData(gameId); 
  if (!gameData) {
    return;
  }

  const handsFreeMode = gameData.settings.handsFreeMode;
  const timePerAnswer = (gameData.settings.timePerAnswer || 10) * 1000;  
  const currentQuestionIndex = gameData.currentQuestionIndex;
  const quizLength = gameData.quizQuestions.length || 5;

  const players = await playerDb.getPlayers(gameId);
  const subjectPlayerId = gameData.quizQuestions[currentQuestionIndex].playerId;

  const nonSubjectPlayers = players.filter(p => p.id !== subjectPlayerId);
  const guessingPlayers = players.filter(p => p.quizGuesses[currentQuestionIndex]);
  const guesses = await playerDb.getPlayerGuessesForQuizQuestion(gameId, currentQuestionIndex);

  const correctGuess = gameData.quizQuestions[currentQuestionIndex].correctAnswerIndex;
  const totalGuesses = guesses.length - 1;
  const numCorrect = guesses.filter(g => g && g.guess === correctGuess).length;

  if (subjectPlayerId === "friends") {
    await handleTiebreakerAnswers(players, currentQuestionIndex, correctGuess);
  } else if (totalGuesses === 0 || numCorrect === 0) {
    playerDb.awardAllPlayersConsolationPoints(guessingPlayers, currentQuestionIndex);
  }

  const subjectPlayer = await playerDb.getPlayer(subjectPlayerId);
  let subjectBonus = Math.floor(300 * (numCorrect / totalGuesses));

  if (subjectPlayer) {
    subjectBonus = isNaN(subjectBonus) ? 0 : subjectBonus;

    await Player.updateOne({
      id: subjectPlayer.id
    }, { 
      $set: {
        'score': subjectPlayer.score + subjectBonus
      }
    });

    const newSubjectPlayerState = numCorrect === 0 ? PlayerStates.SeeingAnswerIncorrect : PlayerStates.SeeingAnswerCorrect
    playerDb.updatePlayerState(subjectPlayer.id, newSubjectPlayerState, io, {});
  }

  for (let i = 0; i < nonSubjectPlayers.length; i++) {
    const currentPlayer: IPlayer = nonSubjectPlayers[i];
    const currentPlayerCurrentGuess: IGuess = currentPlayer.quizGuesses[currentQuestionIndex];
    const playerCorrect: boolean = currentPlayerCurrentGuess && currentPlayerCurrentGuess.guess === correctGuess;
    const currentPlayerNewState: PlayerStates = playerCorrect ? PlayerStates.SeeingAnswerCorrect : PlayerStates.SeeingAnswerIncorrect;

    await playerDb.updatePlayerState(currentPlayer.id, currentPlayerNewState, io, {});
  }

  const playerScores = await playerDb.getPlayerScores(gameId)
  io.to(gameData.hostSocketId).emit('host-next', { ...gameData, quizQuestionGuesses: guesses, playerScores: playerScores});

  if (handsFreeMode) {
    setTimeout(() => {
      if ((currentQuestionIndex + 1) < quizLength) {
        hostShowIntLeaderboard(gameId, io);
      } else {
        hostNextQuestionOrLeaderboard(gameId, io);
      }
    }, timePerAnswer);
  }
}

const getQuestionnaireStatus = async (gameId:number): Promise<any> => {
  const allPlayersInGame = await playerDb.getPlayers(gameId);
  let donePlayers: any = [];
  let waitingPlayers: any = [];

  for (let i = 0; i < allPlayersInGame.length; i++) {
    const player = allPlayersInGame[i];
    if (player.playerState.state === 'submitted-questionnaire-waiting'){
      donePlayers.push(player.name);
    } else if (player.playerState.state === "filling-questionnaire"){
      waitingPlayers.push(player.name);
    }
  }

  return [donePlayers, waitingPlayers]
}

const onHostViewUpdate = async(gameId, io: Server) => {
  const gameData = await hostDb.getGameData(gameId);

  if (gameData === null) {
    return;
  }

  try {
    const allPlayersDone = await playerDb.checkAllPlayersDoneWithQuestionnaire(gameId);
    if (!allPlayersDone) {
      const playerStatusLists = await getQuestionnaireStatus(gameId);
      io.to(gameData.hostSocketId).emit('update-host-view', playerStatusLists);
    } else if (gameData.gameState.state === GameStates.Questionnaire) {
      await hostStartQuiz(gameId, io);
    }
  } catch (e) {
    io.to(gameData.hostSocketId).emit("onHostViewUpdate-error", e);
  }
}

const handlePlayerQuit = async function(player: IPlayer, game: IGame, io: Server) {
  await playerDb.kickPlayer(player.name, game.id);
  const allPlayersInGame = await playerDb.getPlayers(game.id);

  await io.to(game.hostSocketId).emit('players-updated', {
    gameId: game.id,
    players: allPlayersInGame
  });
  
  await onHostViewUpdate(game.id, io);
}

export default { hostStartQuiz, hostPreAnswer, onHostViewUpdate,  hostNextQuestionOrLeaderboard, hostSkipTimer, hostShowIntLeaderboard, hostStartQuizTimer, hostPreLeaderBoard, handlePlayerQuit };
