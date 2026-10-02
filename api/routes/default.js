const unknownEndpoint = (req, res) => {
  res.status(404).json({ code: "UNKNOWN_ENDPOINT", error: "unknown endpoint" });
};

module.exports.unknownEndpoint = unknownEndpoint;
