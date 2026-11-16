// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract DecisionAnchor {
    address public immutable owner = msg.sender;
    mapping(bytes32 => bool) public exists;
    event Anchored(bytes32 indexed fingerprint);

    function anchor(bytes32 fingerprint) external {
        require(msg.sender == owner, "owner required");
        if (exists[fingerprint]) return;
        exists[fingerprint] = true;
        emit Anchored(fingerprint);
    }
}
