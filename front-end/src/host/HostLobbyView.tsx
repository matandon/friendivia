import * as React from "react";
import "../style.css";
import { Button, Paper } from "@mui/material";
import { Socket } from "socket.io-client";

interface ILobbyViewProps {
  playerNames: string[];
  gameId: number;
  socket: Socket;
}

export default function HostLobbyView(props: ILobbyViewProps) {
  const { playerNames, gameId, socket } = props;

  async function onStart() {
    socket.emit("host-start", gameId);
  }

  async function onPlayerKick(name: string) {
    socket.emit("host-kick-player", name);
  }

  return (
    <>
      <h2>Join at friendpardy.com</h2>
      <Paper elevation={3} className="gameid">
        <p className="id">{gameId}</p>
      </Paper>
      <h1>{playerNames.length} Players</h1>
      <ul className="ul">
        {playerNames.map((name: string, i: number) => (
          <li key={i}>
            <Paper
              elevation={3}
              sx={{
                "&:hover": {
                  cursor: "pointer",
                  boxShadow: 8,
                  textDecoration: "strike-through",
                },
              }}
              className="lobby_player"
              onClick={() => onPlayerKick(name)}
            >
              <p className="player">{name}</p>
            </Paper>
            <br />
          </li>
        ))}
      </ul>
      <Button
        variant="contained"
        disabled={playerNames.length < 2}
        sx={{
          bgcolor:
            getComputedStyle(document.body).getPropertyValue("--accent") + ";",
        }}
        onClick={onStart}
      >
        Start
      </Button>
    </>
  );
}
